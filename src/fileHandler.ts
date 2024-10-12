import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { Model } from 'sequelize'
import Nodes from './nodes.js'
import { Instance } from 'webtorrent'
import Hydrafiles from './hydrafiles.js'
const WebTorrentPromise = import('webtorrent')

interface Metadata { name: string, size: number, type: string, hash: string, id: string, infohash: string }

// TODO: Log common user-agents and use the same for requests to slightly anonymise clients

const DIRNAME = path.resolve()
const seeding: string[] = []

let webtorrent: Instance | null = null
export const webtorrentClient = async (): Promise<Instance> => {
  if (webtorrent === null) {
    const WebTorrent = (await WebTorrentPromise).default
    webtorrent = new WebTorrent()
  }
  return webtorrent
}

export interface FileAttributes {
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
  client!: Hydrafiles

  public static async init (opts: { hash?: string, infohash?: string }, client: Hydrafiles): Promise<FileHandler> {
    let hash: string
    if (opts.hash !== undefined) hash = opts.hash
    else if (opts.infohash !== undefined) {
      if (!client.utils.isValidInfoHash(opts.infohash)) throw new Error(`Invalid infohash provided: ${opts.infohash}`)
      const file = await (await client.FileModel).findOne({ where: { infohash: opts.infohash } })
      if (typeof file?.dataValues.hash === 'string') hash = file?.dataValues.hash
      else {
        // TODO: Check against other nodes
        hash = ''
      }
    } else throw new Error('No hash or infohash provided')
    if (hash !== undefined && !client.utils.isValidSHA256Hash(hash)) throw new Error('Invalid hash provided')

    const fileHandler = new FileHandler()
    fileHandler.hash = hash
    fileHandler.infohash = ''
    fileHandler.id = ''
    fileHandler.name = ''
    fileHandler.found = true
    fileHandler.size = 0
    fileHandler.client = client

    const existingFile = await (await client.FileModel).findByPk(hash)
    fileHandler.file = existingFile ?? await (await client.FileModel).create({ hash })
    Object.assign(fileHandler, fileHandler.file.dataValues)
    if (Number(fileHandler.size) === 0) fileHandler.size = 0

    return fileHandler
  }

  public static findFile = async (where: FileAttributes, client: Hydrafiles): Promise<void> => {
    await (await client.FileModel).findOne({ where })
  }

  public async getMetadata (): Promise<FileHandler | false> {
    if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0) return this

    const hash = this.hash

    console.log(`  ${hash}  Getting file metadata`)

    const id = this.id
    if (id !== undefined && id !== null && id.length > 0) {
      const response = await fetch(`${this.client.config.metadata_endpoint}${id}`)
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

    if (this.client.config.s3_endpoint.length !== 0) {
      try {
        const data = await this.client.s3.headObject({ Bucket: 'uploads', Key: `${hash}.stuf` })
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
    const remainingSpace = this.client.utils.remainingStorage()
    if (this.client.config.max_cache !== -1 && size > remainingSpace) this.client.utils.purgeCache(size, remainingSpace)

    await this.client.utils.saveBufferToFile(file, filePath)
  }

  private async fetchFromCache (): Promise<{ file: Buffer, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Checking Cache`)
    const filePath = path.join(DIRNAME, 'files', hash)
    await this.seed()
    return fs.existsSync(filePath) ? { file: fs.readFileSync(filePath), signal: this.client.utils.interfere(100) } : false
  }

  async fetchFromS3 (): Promise<{ file: Buffer, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Checking S3`)
    if (this.client.config.s3_endpoint.length === 0) return false
    try {
      let buffer: Buffer
      const data = await this.client.s3.getObject({ Bucket: 'uploads', Key: `${hash}.stuf` })

      if (data.Body instanceof Readable) {
        const chunks: any[] = []
        for await (const chunk of data.Body) {
          chunks.push(chunk)
        }
        buffer = Buffer.concat(chunks)
      } else if (data.Body instanceof Buffer) buffer = data.Body
      else return false

      if (this.client.config.cache_s3) await this.cacheFile(buffer)
      return { file: buffer, signal: this.client.utils.interfere(100) }
    } catch (e) {
      const err = e as { message: string }
      if (err.message !== 'The specified key does not exist.') console.error(err)
      return false
    }
  }

  // TODO: fetchFromTorrent
  // TODO: Connect to other hydrafiles nodes as webseed
  // TODO: Check other nodes file lists to find other claimed infohashes for the file, leech off all of them and copy the metadata from the healthiest torrent

  async getFile (nodesManager: Nodes, opts: { logDownloads?: boolean } = {}): Promise<{ file: Buffer, signal: number } | false> {
    const hash = this.hash
    console.log(`  ${hash}  Getting file`)
    if (!this.client.utils.isValidSHA256Hash(hash)) return false
    if (!this.found && new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)) return false
    if (opts.logDownloads === undefined || opts.logDownloads) await this.increment('downloadCount')
    await this.save()

    if (this.size !== 0 && !this.client.utils.hasSufficientMemory(this.size)) {
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (this.client.config.log_level === 'verbose') console.log(`  ${hash}  Reached memory limit, waiting`, this.size)
          if (this.size === 0 || this.client.utils.hasSufficientMemory(this.size)) clearInterval(intervalId)
        }, this.client.config.memory_threshold_reached_wait)
      })
    }

    let file = await this.fetchFromCache()
    if (file !== false) console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`)
    else {
      if (this.client.config.s3_endpoint.length > 0) file = await this.fetchFromS3()
      if (file !== false) console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`)
      else {
        file = await nodesManager.getFile(hash, this.size)
        if (file === false) {
          this.found = false
          await this.save()
        }
      }
    }

    if (file !== false) await this.seed()

    return file
  }

  async save (): Promise<void> {
    const values = Object.keys(this).reduce((row: Record<string, any>, key: string) => {
      if (key !== 'file' && key !== 'save') row[key] = this[key as keyof FileAttributes]
      return row
    }, {})

    Object.assign(this.file, values)
    await this.file.save()
  }

  async seed (): Promise<void> {
    if (seeding.includes(this.hash)) return
    seeding.push(this.hash)
    const filePath = path.join(DIRNAME, 'files', this.hash)
    if (!fs.existsSync(filePath)) return
    (await webtorrentClient()).seed(filePath, {
      // @ts-expect-error
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

// TODO: webtorrent.add() all known files
