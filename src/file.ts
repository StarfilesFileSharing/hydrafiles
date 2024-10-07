import { S3 } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { Sequelize, Model, DataTypes } from 'sequelize'
import CONFIG from './config'
import { hasSufficientMemory, interfere, isValidSHA256Hash } from './utils'
import Nodes from './nodes'

export interface File { file: Buffer, name?: string, signal: number }
export interface Metadata { name: string, size: number, type: string, hash: string, id: string }

const DIRNAME = path.resolve()

class File extends Model {
  public hash!: string
  public download_count!: number
  public id!: string
  public name!: string
  public found!: boolean
  public size!: number
  public updatedAt!: number

  public static initialize (sequelize: Sequelize): void {
    File.init(
      {
        hash: {
          type: DataTypes.STRING,
          primaryKey: true
        },
        download_count: {
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
        createdAt: {
          type: DataTypes.DATE
        },
        updatedAt: {
          type: DataTypes.DATE
        }
      },
      {
        sequelize,
        tableName: 'file'
      }
    )
  }
}

class FileManager {
  private usedStorage: number
  private readonly s3: S3
  private readonly sequelize: Sequelize
  private readonly nodesManager: Nodes

  constructor (nodesManager: Nodes) {
    this.s3 = new S3({
      region: 'us-east-1',
      credentials: {
        accessKeyId: CONFIG.s3_access_key_id,
        secretAccessKey: CONFIG.s3_secret_access_key
      },
      endpoint: CONFIG.s3_endpoint
    })

    this.usedStorage = 0
    const filesPath = path.join(DIRNAME, 'files')
    if (fs.existsSync(filesPath)) {
      const files = fs.readdirSync(filesPath)
      for (const file of files) {
        const stats = fs.statSync(path.join(filesPath, file))
        this.usedStorage += stats.size
      }
    }
    console.log(`Files dir size: ${Math.round(100 * this.usedStorage / 1024 / 1024 / 1024) / 100}GB`)

    this.nodesManager = nodesManager

    this.sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: path.join(DIRNAME, 'filemanager.db')
    })

    File.initialize(this.sequelize)
    this.initializeDB().then((msg) => {
      console.log(msg)
    }).catch((e) => {
      console.log(e)
    })
  }

  private async initializeDB (): Promise<void> {
    await this.sequelize.sync()
    console.log('Connected to the local DB')
  }

  private async fetchFile (hash: string): Promise<File | false> {
    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) {
      return { file: fs.readFileSync(filePath), signal: interfere(100) }
    }
    return false
  }

  private async getFileSize (hash: string, id: string = ''): Promise<number | false> {
    const fileFromDB = await File.findOne({ where: { hash } })
    if (fileFromDB?.size !== null) {
      return fileFromDB?.size ?? false
    }

    const filePath = path.join(DIRNAME, 'files', hash)

    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath)
      this.setFiletable(hash, undefined, undefined, stats.size).catch(e => console.error(e))
      return stats.size
    }

    try {
      const data = await this.s3.headObject({ Bucket: 'uploads', Key: `${hash}.stuf` })
      if (typeof data.ContentLength !== 'undefined') {
        this.setFiletable(hash, undefined, undefined, data.ContentLength).catch(e => console.error(e))
        return data.ContentLength
      }
    } catch (error) {
      if (id.length !== 0) {
        try {
          const response = await fetch(`${CONFIG.metadata_endpoint}${id}`)
          if (response.status === 200) {
            const metadata = await response.json() as Metadata
            this.setFiletable(hash, undefined, undefined, metadata.size).catch(e => console.error(e))
            return metadata.size
          }
        } catch (error) {
          console.error(error)
        }
      }
    }
    return false
  }

  private async incrementDownloadCount (hash: string): Promise<void> {
    await File.increment('download_count', { where: { hash } })
  }

  private async isFileNotFound (hash: string): Promise<boolean> {
    const file = await File.findOne({ where: { hash } })
    if (file !== null && !file.found) {
      return true
    }
    return false
  }

  purgeCache (requiredSpace: number, remainingSpace: number): void {
    const files = fs.readdirSync(path.join(process.cwd(), 'files'))
    for (const file of files) {
      if (CONFIG.perma_files.includes(file)) continue

      const size = fs.statSync(path.join(process.cwd(), 'files', file)).size
      fs.unlinkSync(path.join(process.cwd(), 'files', file))
      this.usedStorage -= size
      remainingSpace += size

      if (requiredSpace <= remainingSpace) break
    }
  }

  cacheFile (hash: string, file: Buffer): void {
    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) return

    const size = file.length
    const remainingSpace = CONFIG.max_storage - this.usedStorage
    if (size > remainingSpace) this.purgeCache(size, remainingSpace)

    const writeStream = fs.createWriteStream(filePath)
    const readStream = Readable.from(file)

    readStream.on('error', (err) => console.error('Error reading from buffer:', err))
    writeStream.on('error', (err) => console.error('Error writing to file:', err))
    writeStream.on('finish', (): void => {
      this.usedStorage += size
      console.log(`  ${hash}  Successfully cached file. Used storage: ${this.usedStorage}`)
      this.setFiletable(hash, undefined, undefined, size).catch(e => console.error(e))
    })

    readStream.pipe(writeStream)
  }

  async getFile (hash: string, id: string = ''): Promise<File | false> {
    const fileNotFound = await this.isFileNotFound(hash)
    if (fileNotFound) return false
    if (!isValidSHA256Hash(hash)) return false
    await this.incrementDownloadCount(hash)

    const size = await this.getFileSize(hash, id)
    if (size !== false && !hasSufficientMemory(size)) {
      console.log(`  ${hash}  Reached memory limit, waiting`)
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (hasSufficientMemory(size)) clearInterval(intervalId)
        }, CONFIG.memory_threshold_reached_wait)
      })
    }

    const localFile = await this.fetchFile(hash)
    if (localFile !== false) {
      console.log(`  ${hash}  Serving ${size !== false ? Math.round(size / 1024 / 1024) : 0}MB from cache`)
      await this.setFiletable(hash, id)
      return localFile
    }

    if (CONFIG.s3_endpoint.length > 0) {
      const s3File = await this.fetchFromS3('uploads', `${hash}.stuf`)
      if (s3File !== false) {
        if (CONFIG.cache_s3) this.cacheFile(hash, s3File.file)
        console.log(`  ${hash}  Serving ${size !== false ? Math.round(size / 1024 / 1024) : 0}MB from S3`)
        await this.setFiletable(hash, id)
        return s3File
      }
    }

    const file = await this.nodesManager.getFile(hash, Number(size))
    if (file === false) await this.markFileAsNotFound(hash)
    await this.setFiletable(hash, id)
    return file
  }

  async fetchFromS3 (bucket: string, key: string): Promise<File | false> {
    if (CONFIG.s3_endpoint.length === 0) return false
    try {
      let buffer: Buffer
      const data = await this.s3.getObject({ Bucket: bucket, Key: key })

      if (data.Body instanceof Readable) {
        const chunks: any[] = []
        for await (const chunk of data.Body) {
          chunks.push(chunk)
        }
        buffer = Buffer.concat(chunks)
      } else if (data.Body instanceof Buffer) {
        buffer = data.Body
      } else {
        return false
      }

      return { file: buffer, signal: interfere(100) }
    } catch (error) {
      console.error(error)
      return false
    }
  }

  async markFileAsNotFound (hash: string): Promise<[affectedCount: number]> {
    return await File.update({ found: false }, { where: { hash } })
  }

  async setFiletable (hash: string, id?: string, name?: string, size?: number): Promise<void> {
    await File.upsert({
      hash,
      id,
      name,
      size
    })
  }
}

export default FileManager
