import { S3 } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import CONFIG from './config'
import { hasSufficientMemory, interfere } from './utils'
import Nodes from './nodes'

export interface File { file: Buffer, name?: string, signal: number }
export interface Metadata { name: string, size: string, type: string, hash: string, id: string }

const DIRNAME = path.resolve()

const downloadCount: Record<string, number> = {}

class FileManager {
  private usedStorage: number
  private fileTable: Record<string, { id?: string, name?: string }>
  private readonly s3: S3
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
    this.fileTable = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'filetable.json')).toString())
    this.pendingFiles = []
    this.nodesManager = nodesManager
  }

  // Fetch a file locally or return false if it doesn't exist
  private async fetchFile (hash: string): Promise<File | false> {
    const filePath = path.join(DIRNAME, 'files', hash)
    if (fs.existsSync(filePath)) {
      return { file: fs.readFileSync(filePath), signal: interfere(100) }
    }
    return false
  }

  // Get the file size from local storage, S3, or metadata API
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

  purgeCache (requiredSpace: number, remainingSpace: number): void {
    const files = fs.readdirSync(path.join(process.cwd(), 'files'))
    for (const file of files) {
      if (CONFIG.perma_files.includes(file) || Object.keys(downloadCount).includes(file)) continue

      const size = fs.statSync(path.join(process.cwd(), 'files', file)).size
      fs.unlinkSync(path.join(process.cwd(), 'files', file))
      this.usedStorage -= size
      remainingSpace += size

      if (requiredSpace <= remainingSpace) break
    }

    if (requiredSpace > remainingSpace) {
      const sorted = Object.entries(downloadCount).sort(([,a], [,b]) => Number(a) - Number(b)).filter(([file]) => !CONFIG.perma_files.includes(file))
      for (let i = 0; i < sorted.length / (CONFIG.burn_rate * 100); i++) {
        const stats = fs.statSync(path.join(DIRNAME, 'files', sorted[i][0]))
        fs.unlinkSync(path.join(DIRNAME, 'files', sorted[i][0]))
        this.usedStorage -= stats.size
      }
    }
  }

  cacheFile (filePath: string, file: Buffer): void {
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
      console.log(`Successfully cached file. Used storage: ${this.usedStorage}`)
    })

    readStream.pipe(writeStream)
  }

  async getFile (hash: string, id: string = ''): Promise<File | false> {
    downloadCount[hash] = typeof downloadCount[hash] === 'undefined' ? Number(downloadCount[hash]) + 1 : 1
    if (this.pendingFiles.includes(hash)) {
      console.log('Hash is already pending, waiting for it to be processed')
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (!this.pendingFiles.includes(hash)) clearInterval(intervalId)
        }, 100)
      })
    }

    const size = await this.getFileSize(hash, id)
    if (size !== false && !hasSufficientMemory(size)) {
      console.log('Reached memory limit, waiting')
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (hasSufficientMemory(size)) clearInterval(intervalId)
        }, CONFIG.memory_threshold_reached_wait)
      })
    }

    this.pendingFiles.push(hash)

    const localFile = await this.fetchFile(hash)
    if (localFile !== false) {
      console.log(hash, `Serving ${size !== false ? Math.round(size / 1024 / 1024) : 0}MB from cache`)
      const index = this.pendingFiles.indexOf(hash)
      if (index > -1) this.pendingFiles.splice(index, 1)
      return localFile
    }

    if (CONFIG.s3_endpoint.length > 0) {
      const s3File = await this.fetchFromS3('uploads', `${hash}.stuf`)
      if (s3File !== false) {
        if (CONFIG.cache_s3) this.cacheFile(path.join(DIRNAME, 'files', hash), s3File.file)
        console.log(hash, `Serving ${size !== false ? Math.round(size / 1024 / 1024) : 0}MB from S3`)
        const index = this.pendingFiles.indexOf(hash)
        if (index > -1) this.pendingFiles.splice(index, 1)
        return s3File
      }
    }

    const index = this.pendingFiles.indexOf(hash)
    if (index > -1) this.pendingFiles.splice(index, 1)
    return await this.nodesManager.getFile(hash, Number(size))
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
    if (this.fileTable[hash] !== undefined) this.fileTable[hash] = {}
    if (typeof id !== 'undefined') this.fileTable[hash].id = id
    if (typeof name !== 'undefined') this.fileTable[hash].name = name
    fs.writeFileSync(path.join(process.cwd(), 'filetable.json'), JSON.stringify(this.fileTable, null, 2))
  }
}

export default FileManager
