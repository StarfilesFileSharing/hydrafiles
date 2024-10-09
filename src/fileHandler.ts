import { S3 } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { Sequelize, Model, DataTypes } from 'sequelize'
import CONFIG from './config'
import { hasSufficientMemory, interfere, isValidSHA256Hash, promiseWithTimeout, streamLength } from './utils'
import Nodes from './nodes'
import WebTorrent from 'webtorrent'

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

const webtorrent = new WebTorrent()
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
  id: string | null | undefined
  name: string | null | undefined
  found!: boolean
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
    if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0) return this

    const hash = this.hash

    console.log(`  ${hash}  Getting file metadata`)

    const id = this.id
    if (id !== undefined && id !== null && id.length > 0) {
      const response = await fetch(`${CONFIG.metadata_endpoint}${id}`)
      if (response.ok) {
        const metadata = (await response.json()).result as Metadata
        this.name = metadata.name
        this.size = metadata.size
        await this.save()
        return this
      }
    }

    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) {
      this.size = fs.statSync(filePath).size
      await this.save()
      return this
    }

    if (CONFIG.s3_endpoint.length !== 0) {
      try {
        const data = await s3.headObject({ Bucket: 'uploads', Key: `${hash}.stuf` })
        if (typeof data.ContentLength !== 'undefined') {
          this.size = data.ContentLength
          await this.save()
          return this
        }
      } catch (error) {
        console.error(error)
      }
    }

    return false
  }

  async cacheFile (file: Readable): Promise<void> {
    const hash = this.hash
    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) return

    let size = this.size
    if (size === 0) {
      size = await streamLength(file)
      this.size = size
      await this.save()
    }
    const remainingSpace = CONFIG.max_storage - usedStorage
    if (size > remainingSpace) purgeCache(size, remainingSpace)

    const writeStream = fs.createWriteStream(filePath)

    file.on('error', (err) => console.error('Error reading from stream:', err))
    writeStream.on('error', (err) => console.error('Error writing to file:', err))
    writeStream.on('finish', (): void => {
      usedStorage += size
      console.log(`  ${hash}  Successfully cached file. Used storage: ${usedStorage}`)
      this.seed()
    })

    file.pipe(writeStream)
  }

  private async fetchFromCache (): Promise<{ file: Readable, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Checking Cache`)
    const filePath = path.join(DIRNAME, 'files', hash)
    return fs.existsSync(filePath) ? { file: fs.createReadStream(filePath), signal: interfere(100) } : false
  }

  async fetchFromS3 (): Promise<{ file: Readable, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Checking S3`)
    if (CONFIG.s3_endpoint.length === 0) return false
    try {
      let stream: Readable
      const data = await s3.getObject({ Bucket: 'uploads', Key: `${hash}.stuf` })

      if (data.Body instanceof Readable) stream = data.Body
      else if (data.Body instanceof Buffer) stream = Readable.from(data.Body)
      else return false

      return { file: stream, signal: interfere(100) }
    } catch (error) {
      if (error.message !== 'The specified key does not exist.') console.error(error)
      return false
    }
  }

  async getFile (nodesManager: Nodes): Promise<{ file: Readable, signal: number } | false> {
    return await promiseWithTimeout((async (): Promise<{ file: Readable, signal: number } | false> => {
      const hash = this.hash
      console.log(`  ${hash}  Getting file`)
      if (!isValidSHA256Hash(hash)) return false
      if (!this.found && new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)) return false
      const downloadCount = this.downloadCount + 1
      this.downloadCount = downloadCount
      await this.save()

      if (this.size !== 0 && !hasSufficientMemory(this.size)) {
        await new Promise(() => {
          const intervalId = setInterval(() => {
            console.log(`  ${hash}  Reached memory limit, waiting`, this.size)
            if (this.size === 0 || hasSufficientMemory(this.size)) clearInterval(intervalId)
          }, CONFIG.memory_threshold_reached_wait)
        })
      }

      const localFile = await this.fetchFromCache()
      if (localFile !== false) {
        console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`)
        return localFile
      }

      if (CONFIG.s3_endpoint.length > 0) {
        const s3File = await this.fetchFromS3()
        if (s3File !== false) {
          if (CONFIG.cache_s3) await this.cacheFile(s3File.file)
          console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`)
          return s3File
        }
      }

      const file = await promiseWithTimeout(nodesManager.getFile(hash, this.size), CONFIG.timeout)
      if (file === false) {
        this.found = false
        await this.save()
      }
      await this.cacheFile(file)
      return file
    })(), CONFIG.timeout)
  }

  async save (): Promise<void> {
    const values = Object.keys(this).reduce((acc, key) => {
      if (key !== 'file' && key !== 'save') acc[key] = this[key as keyof FileAttributes]
      return acc
    }, {})
    Object.assign(this.file, values)
    await this.file.save()
  }

  seed (): void {
    webtorrent.seed(path.join(DIRNAME, 'files', this.hash), {}, (torrent) => {
      console.log(`  ${this.hash}  Seeding`, torrent)
    })
  }
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(DIRNAME, 'filemanager.db'),
  logging: (...msg) => {
    const payload = msg[1] as unknown as { type: string, where: string, instance: { dataValues: { hash: string } }, fields: string[] }
    if (payload.type === 'SELECT') {
      console.log(`  ${payload.where.split("'")[1]}  SELECTing file from database`)
    } else if (payload.type === 'INSERT') {
      console.log(`  ${payload.instance.dataValues.hash}  INSERTing file to database`)
    } else if (payload.type === 'UPDATE') {
      console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Changing columns: ${payload.fields.join(', ')}`)
    }
  }
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
