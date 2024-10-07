import { S3 } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { Sequelize, Model, DataTypes } from 'sequelize'
import CONFIG from './config'
import { hasSufficientMemory, interfere, isValidSHA256Hash, promiseWithTimeout } from './utils'
import Nodes from './nodes'

interface Metadata { name: string, size: number, type: string, hash: string, id: string }
interface ConstructorOptions {
  hash: string
  id?: string
  downloadCount?: number
  found?: boolean
  size?: number
  name?: string
}

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

export default class File extends Model {
  public hash!: string
  public downloadCount!: number
  public id!: string
  public name!: string
  public found!: boolean
  public size!: number
  public createdAt!: Date
  public updatedAt!: Date

  constructor (options: ConstructorOptions) {
    super()
    if (this.get('hash') === undefined && options.hash !== undefined) this.set('hash', options.hash)
    if (this.get('id') === undefined && options.id !== undefined) this.set('id', options.id)
    if (this.get('downloadCount') === undefined && options.downloadCount !== undefined) this.set('downloadCount', options.downloadCount ?? 0)
    if (this.get('found') === undefined && options.found !== undefined) this.set('found', options.found ?? true)
    if (this.get('size') === undefined && options.size !== undefined) this.set('size', options.size ?? 0)
    if (this.get('name') === undefined && options.name !== undefined) this.set('name', options.name)
    this.hash = this.get('hash')
    this.id = this.get('id')
    this.downloadCount = this.get('downloadCount')
    this.found = this.get('found')
    this.size = this.get('size')
    this.name = this.get('name')
  }

  public async getSize (): Promise<number | false> {
    if (this.size !== 0) return this.size

    const filePath = path.join(DIRNAME, 'files', this.hash)
    if (fs.existsSync(filePath)) {
      this.size = fs.statSync(filePath).size
      await this.save()
      return this.size
    }

    try {
      const data = await s3.headObject({ Bucket: 'uploads', Key: `${this.hash}.stuf` })
      if (typeof data.ContentLength !== 'undefined') {
        this.size = data.ContentLength
        await this.save()
        return data.ContentLength
      }
    } catch (error) {
      console.error(error)
    }

    return false
  }

  public async getName (): Promise<string | undefined> {
    if (this.name !== undefined) return this.name
    if (typeof this.id !== 'undefined') {
      const response = await fetch(`${CONFIG.metadata_endpoint}${this.id}`)
      if (response.status === 200) {
        this.name = (await response.json() as Metadata).name
        await this.save()
      }
    }
    return this.name
  }

  cacheFile (file: Buffer): void {
    const filePath = path.join(DIRNAME, 'files', this.hash)
    if (fs.existsSync(filePath)) return

    if (this.size === 0) {
      this.size = file.length
      this.save().catch(e => console.error(e))
    }
    const remainingSpace = CONFIG.max_storage - usedStorage
    if (this.size > remainingSpace) purgeCache(this.size, remainingSpace)

    const writeStream = fs.createWriteStream(filePath)
    const readStream = Readable.from(file)

    readStream.on('error', (err) => console.error('Error reading from buffer:', err))
    writeStream.on('error', (err) => console.error('Error writing to file:', err))
    writeStream.on('finish', (): void => {
      usedStorage += this.size
      console.log(`  ${this.hash}  Successfully cached file. Used storage: ${usedStorage}`)
    })

    readStream.pipe(writeStream)
  }

  private async fetchFromCache (): Promise<{ file: Buffer, signal: number } | false> {
    const filePath = path.join(DIRNAME, 'files', this.hash)
    return fs.existsSync(filePath) ? { file: fs.readFileSync(filePath), signal: interfere(100) } : false
  }

  async fetchFromS3 (): Promise<{ file: Buffer, signal: number } | false> {
    if (CONFIG.s3_endpoint.length === 0) return false
    try {
      let buffer: Buffer
      const data = await s3.getObject({ Bucket: 'uploads', Key: `${this.hash}.stuf` })

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
    const func = async (): Promise<{ file: Buffer, signal: number } | false> => {
      if (!isValidSHA256Hash(this.hash)) return false
      if (!this.found) return false
      this.downloadCount += 1
      await this.save()

      if (this.size === 0) await this.getSize()

      if (this.size !== 0 && !hasSufficientMemory(this.size)) {
        console.log(`  ${this.hash}  Reached memory limit, waiting`)
        await new Promise(() => {
          const intervalId = setInterval(() => {
            if (hasSufficientMemory(this.size)) clearInterval(intervalId)
          }, CONFIG.memory_threshold_reached_wait)
        })
      }

      const localFile = await this.fetchFromCache()
      if (localFile !== false) {
        console.log(`  ${this.hash}  Serving ${this.size !== 0 ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`)
        return localFile
      }

      if (CONFIG.s3_endpoint.length > 0) {
        const s3File = await this.fetchFromS3()
        if (s3File !== false) {
          if (CONFIG.cache_s3) this.cacheFile(s3File.file)
          console.log(`  ${this.hash}  Serving ${this.size !== 0 ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`)
          return s3File
        }
      }

      const file = await nodesManager.getFile(this.hash, Number(this.size))
      if (file === false) {
        this.found = false
        await this.save()
      }
      return file
    }
    return await promiseWithTimeout(func(), CONFIG.timeout)
  }
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(DIRNAME, 'filemanager.db')
})
File.init(
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
    sequelize,
    tableName: 'file',
    timestamps: true
  }
)
sequelize.sync().then(() => console.log('Connected to the local DB')).catch(error => console.error('Error connecting to the database:', error))
