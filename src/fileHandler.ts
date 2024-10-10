import { S3 } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { Sequelize, Model, DataTypes } from 'sequelize'
import CONFIG from './config'
import { hasSufficientMemory, interfere, isValidInfoHash, isValidSHA256Hash, promiseWithTimeout, saveBufferToFile, remainingStorage, purgeCache } from './utils'
import Nodes from './nodes'
import WebTorrent from 'webtorrent'
import SequelizeSimpleCache from 'sequelize-simple-cache'

interface Metadata { name: string, size: number, type: string, hash: string, id: string, infohash: string }

const DIRNAME = path.resolve()

export const webtorrent = new WebTorrent()
const s3 = new S3({
  region: 'us-east-1',
  credentials: {
    accessKeyId: CONFIG.s3_access_key_id,
    secretAccessKey: CONFIG.s3_secret_access_key
  },
  endpoint: CONFIG.s3_endpoint
})
// TODO: Log common user-agents and use the same for requests to slightly anonymise clients
const seeding: string[] = []

interface FileAttributes {
  hash: string
  infohash: string
  downloadCount: number | undefined
  id: string
  name: string
  found: boolean
  size: number
  createdAt: Date
  updatedAt: Date
}

export default class FileHandler {
  hash!: string
  infohash: string | null | undefined
  downloadCount: number | undefined
  id: string | null | undefined
  name: string | null | undefined
  found!: boolean
  size!: number
  createdAt!: Date
  updatedAt!: Date
  file!: Model<any, any>

  public static async init (opts: { hash?: string, infohash?: string }): Promise<FileHandler> {
    let hash: string
    if (opts.hash !== undefined) hash = opts.hash
    else if (opts.infohash !== undefined) {
      if (!isValidInfoHash(opts.infohash)) throw new Error(`Invalid infohash provided: ${opts.infohash}`)
      const file = await FileModel.findOne({ where: { infohash: opts.infohash } })
      if (typeof file?.dataValues.hash === 'string') hash = file?.dataValues.hash
      else {
        // TODO: Check against other nodes
        hash = ''
      }
    } else throw new Error('No hash or infohash provided')
    if (hash !== undefined && !isValidSHA256Hash(hash)) throw new Error('Invalid hash provided')

    const fileHandler = new FileHandler()
    fileHandler.hash = hash
    fileHandler.infohash = ''
    fileHandler.id = ''
    fileHandler.name = ''
    fileHandler.found = true
    fileHandler.size = 0

    const existingFile = await FileModel.findByPk(hash)
    fileHandler.file = existingFile ?? await FileModel.create({ hash })
    Object.assign(fileHandler, fileHandler.file.dataValues)
    if (Number(fileHandler.size) === 0) fileHandler.size = 0

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
        if (this.infohash?.length === 0) this.infohash = metadata.infohash
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

  async cacheFile (file: Buffer): Promise<void> {
    const hash = this.hash
    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) return

    let size = this.size
    if (size === 0) {
      size = file.byteLength
      this.size = size
      await this.save()
    }
    const remainingSpace = remainingStorage()
    if (CONFIG.max_storage !== -1 && size > remainingSpace) purgeCache(size, remainingSpace)

    await saveBufferToFile(file, filePath)
  }

  private async fetchFromCache (): Promise<{ file: Buffer, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Checking Cache`)
    const filePath = path.join(DIRNAME, 'files', hash)
    this.seed()
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

      if (CONFIG.cache_s3) await this.cacheFile(buffer)
      return { file: buffer, signal: interfere(100) }
    } catch (error) {
      if (error.message !== 'The specified key does not exist.') console.error(error)
      return false
    }
  }

  // TODO: fetchFromTorrent
  // TODO: Connect to other hydrafiles nodes as webseed
  // TODO: Check other nodes file lists to find other claimed infohashes for the file, leech off all of them and copy the metadata from the healthiest torrent

  async getFile (nodesManager: Nodes): Promise<{ file: Buffer, signal: number } | false> {
    return await promiseWithTimeout((async (): Promise<{ file: Buffer, signal: number } | false> => {
      const hash = this.hash
      console.log(`  ${hash}  Getting file`)
      if (!isValidSHA256Hash(hash)) return false
      if (!this.found && new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)) return false
      await this.increment('downloadCount')
      await this.save()

      if (this.size !== 0 && !hasSufficientMemory(this.size)) {
        await new Promise(() => {
          const intervalId = setInterval(() => {
            console.log(`  ${hash}  Reached memory limit, waiting`, this.size)
            if (this.size === 0 || hasSufficientMemory(this.size)) clearInterval(intervalId)
          }, CONFIG.memory_threshold_reached_wait)
        })
      }

      let file = await this.fetchFromCache()
      if (file !== false) console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`)
      else {
        if (CONFIG.s3_endpoint.length > 0) file = await this.fetchFromS3()
        if (file !== false) console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`)
        else {
          file = await nodesManager.getFile(hash, this.size)
          if (file === false) {
            this.found = false
            await this.save()
          }
        }
      }

      if (file !== false) this.seed()

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
    if (seeding.includes(this.hash)) return
    seeding.push(this.hash)
    const filePath = path.join(DIRNAME, 'files', this.hash)
    if (!fs.existsSync(filePath)) return
    webtorrent.seed(filePath, {
      createdBy: 'Hydrafiles/0.1',
      name: (this.name ?? this.hash).replace(/(\.\w+)$/, ' [HYDRAFILES]$1'),
      destroyStoreOnDestroy: true,
      addUID: true,
      comment: 'Anonymously seeded with Hydrafiles'
    }, async (torrent) => {
      console.log(`  ${this.hash}  Seeding with infohash ${torrent.infoHash}`)
      this.infohash = torrent.infoHash
      await this.save()
    })
  }

  async increment (column: string): Promise<void> {
    await this.file.increment(column)
  }
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(DIRNAME, 'filemanager.db'),
  logging: (...msg) => {
    const payload = msg[1] as unknown as { type: string, where?: string, instance: { dataValues: { hash: string } }, fields?: string[], increment: boolean }
    if (payload.type === 'SELECT') {
      if (payload.where !== undefined) console.log(`  ${payload.where.split("'")[1]}  SELECTing file from database`)
    } else if (payload.type === 'INSERT') {
      console.log(`  ${payload.instance.dataValues.hash}  INSERTing file to database`)
    } else if (payload.type === 'UPDATE') {
      if (payload.fields !== undefined) console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Changing columns: ${payload.fields.join(', ')}`)
      else if (payload.increment) console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Incrementing Value`)
      else {
        console.error('Unknown database action')
        console.log(payload)
      }
    }
  }
})

const UncachedFileModel = sequelize.define('File',
  {
    hash: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    infohash: {
      type: DataTypes.STRING
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

const cache = new SequelizeSimpleCache({ File: { ttl: 30 * 60 } })

export const FileModel = cache.init(UncachedFileModel)

export const startDatabase = async (): Promise<void> => {
  await sequelize.sync({ alter: true })
  console.log('Connected to the local DB')
}

// TODO: webtorrent.add() all known files
