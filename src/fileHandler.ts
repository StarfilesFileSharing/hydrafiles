import { S3 } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { Sequelize, Model, DataTypes } from 'sequelize'
import CONFIG from './config'
import { hasSufficientMemory, interfere, isValidSHA256Hash, promiseWithTimeout } from './utils'
import Nodes from './nodes'

interface Metadata { name: string, size: number, type: string, hash: string, id: string }

const DIRNAME = path.resolve()

let usedStorage = 0
const filesPath = path.join(DIRNAME, 'files')
if (fs.existsSync(filesPath)) {
  const files = fs.readdirSync(filesPath)
  for (const file of files) {
    const stats = fs.statSync(path.join(filesPath, file))
    usedStorage += stats.size
  }
}
console.log(`Files dir size: ${Math.round((100 * usedStorage) / 1024 / 1024 / 1024) / 100}GB`)

const s3 = new S3({
  region: 'us-east-1',
  credentials: {
    accessKeyId: CONFIG.s3_access_key_id,
    secretAccessKey: CONFIG.s3_secret_access_key
  },
  endpoint: CONFIG.s3_endpoint
})

const purgeCache = (requiredSpace: number, remainingSpace: number): void => {
  const files = fs.readdirSync(path.join(process.cwd(), 'files'))
  for (const file of files) {
    if (CONFIG.perma_files.includes(file)) continue

    const size = fs.statSync(path.join(process.cwd(), 'files', file)).size
    fs.unlinkSync(path.join(process.cwd(), 'files', file))
    usedStorage -= size
    remainingSpace += size

    if (requiredSpace <= remainingSpace) break
  }
}

interface FileAttributes {
  hash: string
  downloadCount: number
  id: string
  name: string
  found: boolean
  size: number
  createdAt: Date
  updatedAt: Date
}

export default class FileHandler {
  hash!: string
  downloadCount!: number
  id: string | undefined
  name: string | undefined
  found: boolean | undefined
  size!: number
  createdAt!: Date
  updatedAt!: Date
  file!: Model<any, any>

  public static async init (hash: string): Promise<FileHandler> {
    if (!isValidSHA256Hash(hash)) throw new Error('Invalid hash provided')

    const fileHandler = new FileHandler()
    fileHandler.hash = hash
    fileHandler.downloadCount = 0
    fileHandler.id = ''
    fileHandler.name = ''
    fileHandler.found = true
    fileHandler.size = 0

    const existingFile = await File.findByPk(hash)
    fileHandler.file = existingFile ?? await File.create({ hash })
    Object.assign(fileHandler, fileHandler.file.dataValues)
    if (Number(fileHandler.size) === 0) fileHandler.size = 0
    if (Number(fileHandler.downloadCount) === 0) fileHandler.downloadCount = 0

    return fileHandler
  }

  public async getMetadata (): Promise<FileHandler | false> {
    if (this.size > 0 && this.name !== undefined && this.name.length > 0) return this

    const hash = this.hash

    console.log(`  ${hash}  Getting file metadata`)

    const id = this.id
    if (id !== undefined && id.length > 0) {
      const response = await fetch(`${CONFIG.metadata_endpoint}${id}`)
      if (response.ok) {
        const metadata = await response.json() as Metadata
        console.log('metadata', metadata)
        this.name = metadata.name
        this.size = metadata.size
        this.save()
        return this
      }
    }

    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) {
      this.size = fs.statSync(filePath).size
      this.save()
      return this
    }

    if (CONFIG.s3_endpoint.length !== 0) {
      try {
        const data = await s3.headObject({ Bucket: 'uploads', Key: `${hash}.stuf` })
        if (typeof data.ContentLength !== 'undefined') {
          this.size = data.ContentLength
          this.save()
          return this
        }
      } catch (error) {
        console.error(error)
      }
    }

    return false
  }

  cacheFile (file: Buffer): void {
    const hash = this.hash
    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) return

    let size = this.size
    if (size === 0) {
      size = file.byteLength
      this.size = size
      this.save()
    }
    const remainingSpace = CONFIG.max_storage - usedStorage
    if (size > remainingSpace) purgeCache(size, remainingSpace)

    const writeStream = fs.createWriteStream(filePath)
    const readStream = Readable.from(file)

    readStream.on('error', (err) => console.error('Error reading from buffer:', err))
    writeStream.on('error', (err) => console.error('Error writing to file:', err))
    writeStream.on('finish', (): void => {
      usedStorage += size
      console.log(`  ${hash}  Successfully cached file. Used storage: ${usedStorage}`)
    })

    readStream.pipe(writeStream)
  }

  private async fetchFromCache (): Promise<{ file: Buffer, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Checking Cache`)
    const filePath = path.join(DIRNAME, 'files', hash)
    return fs.existsSync(filePath) ? { file: fs.readFileSync(filePath), signal: interfere(100) } : false
  }

  async fetchFromS3 (): Promise<{ file: Buffer, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Checking S3`)
    if (CONFIG.s3_endpoint.length === 0) return false
    try {
      let buffer: Buffer
      const data = await s3.getObject({ Bucket: 'uploads', Key: `${hash}.stuf` })

      if (data.Body instanceof Readable) {
        const chunks: any[] = []
        for await (const chunk of data.Body) {
          chunks.push(chunk)
        }
        buffer = Buffer.concat(chunks)
      } else if (data.Body instanceof Buffer) buffer = data.Body
      else return false

      return { file: buffer, signal: interfere(100) }
    } catch (error) {
      console.error(error)
      return false
    }
  }

  async getFile (nodesManager: Nodes): Promise<{ file: Buffer, signal: number } | false> {
    return await promiseWithTimeout((async (): Promise<{ file: Buffer, signal: number } | false> => {
      const hash = this.hash
      console.log(`  ${hash}  Getting file`)
      if (!isValidSHA256Hash(hash)) return false
      // if (!this.found) return false
      const downloadCount = this.downloadCount + 1
      this.downloadCount = downloadCount

      const size = this.size
      if (size === 0) await this.getMetadata()

      if (size !== 0 && !hasSufficientMemory(size)) {
        await new Promise(() => {
          const intervalId = setInterval(() => {
            console.log(`  ${hash}  Reached memory limit, waiting`, size)
            if (size === 0 || hasSufficientMemory(size)) clearInterval(intervalId)
          }, CONFIG.memory_threshold_reached_wait)
        })
      }

      const localFile = await this.fetchFromCache()
      if (localFile !== false) {
        console.log(`  ${hash}  Serving ${size !== undefined ? Math.round(size / 1024 / 1024) : 0}MB from cache`)
        return localFile
      }

      if (CONFIG.s3_endpoint.length > 0) {
        const s3File = await this.fetchFromS3()
        if (s3File !== false) {
          if (CONFIG.cache_s3) this.cacheFile(s3File.file)
          console.log(`  ${hash}  Serving ${size !== undefined ? Math.round(size / 1024 / 1024) : 0}MB from S3`)
          return s3File
        }
      }

      const file = await promiseWithTimeout(nodesManager.getFile(hash, size), CONFIG.timeout)
      if (file === false) {
        this.found = false
        this.save()
      }
      return file
    })(), CONFIG.timeout)
  }

  public save = (): void => {
    const values = Object.keys(this).reduce((acc, key) => {
      if (key !== 'file' && key !== 'save') acc[key] = this[key as keyof FileAttributes]
      return acc
    }, {})
    Object.assign(this.file, values)
    this.file.save().catch(console.error)
  }
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(DIRNAME, 'filemanager.db')
  // logging: (...msg) => console.log(msg)
})

const File = sequelize.define('File',
  {
    hash: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    downloadCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    id: {
      type: DataTypes.STRING
    },
    name: {
      type: DataTypes.STRING
    },
    found: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    size: {
      type: DataTypes.INTEGER
    },
    createdAt: {
      type: DataTypes.DATE
    },
    updatedAt: {
      type: DataTypes.DATE
    }
  },
  {
    tableName: 'file',
    timestamps: true,
    modelName: 'FileHandler'
  }
)
sequelize.sync({ alter: true }).then(() => console.log('Connected to the local DB')).catch(console.error)
