import { S3 } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import sqlite3 from 'sqlite3'
import CONFIG from './config'
import { hasSufficientMemory, interfere, isValidSHA256Hash } from './utils'
import Nodes from './nodes'

export interface File { file: Buffer, name?: string, signal: number }
export interface Metadata { name: string, size: string, type: string, hash: string, id: string }

const DIRNAME = path.resolve()

class FileManager {
  private usedStorage: number
  private readonly s3: S3
  private readonly db: sqlite3.Database
  private readonly pendingFiles: string[]
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

    this.pendingFiles = []
    this.nodesManager = nodesManager

    this.db = new sqlite3.Database(path.join(DIRNAME, 'filemanager.db'), (err) => {
      if (err !== null) console.error('Error opening SQLite database:', err.message)
      else console.log('Connected to the SQLite database.')
    })

    this.initializeDB()
  }

  private initializeDB (): void {
    const createFilesTable = `
      CREATE TABLE IF NOT EXISTS file (
        hash TEXT PRIMARY KEY,
        download_count INTEGER DEFAULT 0,
        last_access_timestamp INTEGER,
        id TEXT,
        name TEXT
      )
    `

    this.db.serialize(() => {
      this.db.run(createFilesTable)
    })
  }

  private async fetchFile (hash: string): Promise<File | false> {
    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) {
      return { file: fs.readFileSync(filePath), signal: interfere(100) }
    }
    return false
  }

  private async getFileSize (hash: string, id: string = ''): Promise<number | false> {
    const filePath = path.join(DIRNAME, 'files', hash)

    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath)
      return stats.size
    }

    try {
      const data = await this.s3.headObject({ Bucket: 'uploads', Key: `${hash}.stuf` })
      if (typeof data.ContentLength !== 'undefined') return data.ContentLength
    } catch (error) {
      if (id.length !== 0) {
        try {
          const response = await fetch(`${CONFIG.metadata_endpoint}${id}`)
          if (response.status === 200) {
            const metadata = await response.json() as Metadata
            return Number(metadata.size)
          }
        } catch (error) {
          console.error(error)
        }
      }
    }
    return false
  }

  private incrementDownloadCount (hash: string): void {
    const query = 'UPDATE file SET download_count = download_count + 1 WHERE hash = ?'
    this.db.run(query, [hash], function (err) {
      if (err != null) console.error('Error incrementing download count:', err.message)
    })
  }

  private async isFileNotFound (hash: string): Promise<boolean> {
    const query = 'SELECT last_access_timestamp FROM file WHERE hash = ?'
    return await new Promise((resolve, reject) => {
      this.db.get(query, [hash], (err, row: { last_access_timestamp: number } | undefined) => {
        if (err !== null) {
          console.log(err)
          reject(err)
        } else if (typeof row !== 'undefined' && row.last_access_timestamp > Date.now() - (1000 * 60 * 5)) resolve(true)
        else resolve(false)
      })
    })
  }

  private markFileAsNotFound (hash: string): void {
    const query = 'INSERT INTO file (hash, last_access_timestamp) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET last_access_timestamp = ?'
    const timestamp = +new Date()
    this.db.run(query, [hash, timestamp, timestamp], function (err) {
      if (err !== null) console.error('Error marking file as not found:', err.message)
    })
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
    writeStream.on('finish', () => {
      this.usedStorage += size
      console.log(`  ${hash}  Successfully cached file. Used storage: ${this.usedStorage}`)
    })

    readStream.pipe(writeStream)
  }

  async getFile (hash: string, id: string = ''): Promise<File | false> {
    const fileNotFound = await this.isFileNotFound(hash)
    if (fileNotFound) return false
    if (!isValidSHA256Hash(hash)) return false
    this.incrementDownloadCount(hash)

    const size = await this.getFileSize(hash, id)
    if (size !== false && !hasSufficientMemory(size)) {
      console.log(`  ${hash}  Reached memory limit, waiting`)
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (hasSufficientMemory(size)) clearInterval(intervalId)
        }, CONFIG.memory_threshold_reached_wait)
      })
    }

    this.pendingFiles.push(hash)

    const localFile = await this.fetchFile(hash)
    if (localFile !== false) {
      console.log(`  ${hash}  Serving ${size !== false ? Math.round(size / 1024 / 1024) : 0}MB from cache`)
      const index = this.pendingFiles.indexOf(hash)
      if (index > -1) this.pendingFiles.splice(index, 1)
      return localFile
    }

    if (CONFIG.s3_endpoint.length > 0) {
      const s3File = await this.fetchFromS3('uploads', `${hash}.stuf`)
      if (s3File !== false) {
        if (CONFIG.cache_s3) this.cacheFile(hash, s3File.file)
        console.log(`  ${hash}  Serving ${size !== false ? Math.round(size / 1024 / 1024) : 0}MB from S3`)
        const index = this.pendingFiles.indexOf(hash)
        if (index > -1) this.pendingFiles.splice(index, 1)
        return s3File
      }
    }

    const index = this.pendingFiles.indexOf(hash)
    if (index > -1) this.pendingFiles.splice(index, 1)
    const file = await this.nodesManager.getFile(hash, Number(size))
    if (file === false) this.markFileAsNotFound(hash)
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

  setFiletable (hash: string, id?: string, name?: string): void {
    const query = 'INSERT INTO file (hash, id, name) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET id = ?, name = ?'
    this.db.run(query, [hash, id, name, id, name], function (err) {
      if (err !== null) console.error('Error updating file_metadata:', err.message)
    })
  }
}

export default FileManager
