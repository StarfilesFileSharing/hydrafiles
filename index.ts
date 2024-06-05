import http from 'http'
import fs from 'fs'
import path from 'path'
import fetch from 'node-fetch'
import crypto from 'crypto'
import { S3 } from '@aws-sdk/client-s3'
import { Readable } from 'stream'

const DIRNAME = path.resolve()

// CONFIG /////////////////////////////////////
let HOSTNAME = '127.0.0.1'
let PORT = 3000
let MAX_STORAGE = 100 * 1024 * 1024 * 1024 // 100GB
let PERMA_FILES: string[] = [] // File hashes to never delete when storage limit is reached
let BURN_RATE = 0.1 // Percentage of files to purge when storage limit is reached
// CONFIG /////////////////////////////////////

// ADVANCED CONFIG ////////////////////////////
let PUBLIC_HOSTNAME = HOSTNAME + (PORT !== 80 && PORT !== 443 ? `:${PORT}` : '') // The hostname that will be used to announce to other nodes
let METADATA_ENDPOINT = 'https://api2.starfiles.co/file/'
let BOOTSTRAP_NODES = [
  { host: 'hydrafiles.com', http: true, dns: false, cf: false },
  { host: 'starfilesdl.com', http: true, dns: false, cf: false },
  { host: 'hydra.starfiles.co', http: true, dns: false, cf: false }
]
let NODES_PATH = path.join(DIRNAME, 'nodes.json')

// Define S3 credentials if you want to pull files from S3
const S3ACCESSKEYID = ''
const S3SECRETACCESSKEY = ''
const S3ENDPOINT = ''
const CACHE_S3 = true // Cache files fetched from S3
// ADVANCED CONFIG ////////////////////////////

// TYPES //////////////////////////////////////
interface Metadata {name: string, size: string, type: string, hash: string, id: string}
interface ResponseHeaders { [key: string]: string }
type File = { file: Buffer, name?: string } | false
interface Node {
  host: string
  http: boolean
  dns: boolean
  cf: boolean
  // File download success/fail count
  hits: number
  rejects: number
}
// TYPES //////////////////////////////////////

// INITIALISATION /////////////////////////////
if (!fs.existsSync(path.join(DIRNAME, 'files'))) fs.mkdirSync(path.join(DIRNAME, 'files'))
if (!fs.existsSync(path.join(DIRNAME, 'nodes.json'))) fs.writeFileSync(path.join(DIRNAME, 'nodes.json'), JSON.stringify(BOOTSTRAP_NODES))
// INITIALISATION /////////////////////////////

// For automated deployments
if (fs.existsSync(path.join(DIRNAME, 'config.json'))) {
  const config = JSON.parse(fs.readFileSync(path.join(DIRNAME, 'config.json')).toString())
  if (config.port !== undefined) PORT = config.port
  if (config.hostname !== undefined) HOSTNAME = config.hostname
  if (config.max_storage !== undefined) MAX_STORAGE = config.max_storage
  if (config.perma_files !== undefined) PERMA_FILES = config.perma_files
  if (config.burn_rate !== undefined) BURN_RATE = config.burn_rate
  if (config.metadata_endpoint !== undefined) METADATA_ENDPOINT = config.metadata_endpoint
  if (config.bootstrap_nodes !== undefined) BOOTSTRAP_NODES = config.bootstrap_nodes
  if (config.nodes_path !== undefined) NODES_PATH = config.nodes_path
  if (config.public_hostname !== undefined) PUBLIC_HOSTNAME = config.public_hostname
}

const isIp = (host: string): boolean => /(?:\d+\.){3}\d+(?::\d+)?/.test(host)

const isPrivateIP = (ip: string): boolean => /^(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255)/.test(ip)

let usedStorage = 0
const downloadCount: { [key: string]: number } = {}

const s3 = new S3({
  region: 'us-east-1',
  credentials: {
    accessKeyId: S3ACCESSKEYID,
    secretAccessKey: S3SECRETACCESSKEY
  },
  endpoint: S3ENDPOINT
})

const purgeCache = (requiredSpace: number, remainingSpace: number): void => {
  const files = fs.readdirSync(path.join(DIRNAME, 'files'))
  for (const file of files) {
    if (PERMA_FILES.includes(file) || Object.keys(downloadCount).includes(file)) continue

    const size = fs.statSync(path.join(DIRNAME, 'files', file)).size
    fs.unlinkSync(path.join(DIRNAME, 'files', file))
    usedStorage -= size
    remainingSpace += size

    if (requiredSpace <= remainingSpace) break
  }
  if (requiredSpace > remainingSpace) {
    const sorted = Object.entries(downloadCount).sort(([,a], [,b]) => Number(a) - Number(b)).filter(([file]) => !PERMA_FILES.includes(file))
    for (let i = 0; i < sorted.length / (BURN_RATE * 100); i++) {
      const stats = fs.statSync(path.join(DIRNAME, 'files', sorted[i][0]))
      fs.unlinkSync(path.join(DIRNAME, 'files', sorted[i][0]))
      usedStorage -= stats.size
    }
  }
}

const cacheFile = (filePath: string, file: Buffer): void => {
  const size = file.length
  const remainingSpace = MAX_STORAGE - usedStorage
  if (size > remainingSpace) purgeCache(size, remainingSpace)
  fs.writeFileSync(filePath, file)
  usedStorage += size
}

const getNodes = (includeSelf = true): Node[] => {
  return JSON.parse(fs.readFileSync(NODES_PATH).toString())
    .filter((node: { host: string }) => includeSelf || node.host !== PUBLIC_HOSTNAME)
    .sort(() => Math.random() - 0.5)
    .sort((a: { hits: number, rejects: number }, b: { hits: number, rejects: number }) => (a.hits - a.rejects) - (b.hits - b.rejects))
}

const downloadFromNode = async (host: string, hash: string): Promise<File> => {
  try {
    const response = await fetch(`${isIp(host) ? 'http' : 'https'}://${host}/download/${hash}`)
    const arrayBuffer = await response.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))

    if (hash !== hashArray.map(b => b.toString(16).padStart(2, '0')).join('')) return false

    const name = response.headers.get('Content-Disposition')?.split('=')[1].replace(/"/g, '')

    return { file: Buffer.from(arrayBuffer), name }
  } catch (e) {
    return false
  }
}

const fetchFromS3 = async (bucket: string, key: string): Promise<File> => {
  if (S3ENDPOINT.length > 0) return false
  try {
    let buffer: Buffer
    const data = await s3.getObject({ Bucket: bucket, Key: key })

    if (data.Body instanceof Readable) {
      const chunks: any[] = []
      for await (const chunk of data.Body) {
        chunks.push(chunk)
      }
      buffer = Buffer.concat(chunks)
    } else if (data.Body instanceof Buffer) { buffer = data.Body } else { return false }

    return { file: buffer }
  } catch (error) {
    console.error(error)
    return false
  }
}

const fetchFile = async (hash: string): Promise<File> => {
  const filePath = path.join(DIRNAME, 'files', hash)
  return fs.existsSync(filePath) ? { file: fs.readFileSync(filePath) } : false
}

const updateNode = (node: Node): void => {
  const nodes = getNodes()
  const index = nodes.findIndex((n: { host: string }) => n.host === node.host)
  nodes[index] = node
  fs.writeFileSync(NODES_PATH, JSON.stringify(nodes))
}

const getFile = async (hash: string): Promise<File> => {
  const filePath = path.join(DIRNAME, 'files', hash)

  const localFile = await fetchFile(hash)
  if (localFile !== false) return localFile

  const s3File = await fetchFromS3('uploads', `${hash}.stuf`)
  if (s3File !== false) {
    if (CACHE_S3) cacheFile(filePath, s3File.file)
    return s3File
  }

  for (const node of getNodes(false)) {
    if (node.http) {
      const file = await downloadFromNode(node.host, hash)
      if (file !== false) {
        node.hits++
        updateNode(node)
        cacheFile(filePath, file.file)
        return file
      } else {
        node.rejects++
        updateNode(node)
      }
    }
  }

  return false
}

const server = http.createServer((req, res) => {
  console.log('  ', req.url)

  const handleRequest = async (): Promise<void> => {
    if (req.url === '/' || req.url === null || typeof req.url === 'undefined') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=604800' })
      fs.createReadStream('index.html').pipe(res)
    } else if (req.url === '/nodes') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' })
      fs.createReadStream(NODES_PATH).pipe(res)
    } else if (req.url.startsWith('/announce')) {
      const params = Object.fromEntries(new URLSearchParams(req.url.split('?')[1]))
      const host = params.host

      const nodes = getNodes()
      if (nodes.find((node) => node.host === host) != null) {
        res.end('Already known\n')
        return
      }

      if (await downloadFromNode(host, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f') !== false) {
        nodes.push({ host, http: true, dns: false, cf: false, hits: 0, rejects: 0 })
        fs.writeFileSync(NODES_PATH, JSON.stringify(nodes))
        res.end('Announced\n')
      } else res.end('Invalid request\n')
    } else if (req.url?.startsWith('/download/')) {
      const hash = req.url.split('/')[2]
      const fileId = req.url.split('/')[3]

      const headers: ResponseHeaders = {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000'
      }

      const file = await getFile(hash)

      if (file === false) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('404 Not Found\n')
        return
      }

      let name: string | undefined
      if (fileId.length > 0) {
        const response = await fetch(`${METADATA_ENDPOINT}${fileId}`)
        if (response.status === 200) name = (await response.json() as Metadata).name
      }

      name = typeof name !== 'undefined' ? name : (file.name ?? 'File')
      headers['Content-Length'] = file.file.length.toString()
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(name).replace(/%20/g, ' ')}"`

      res.writeHead(200, headers)
      res.end(file.file)
      downloadCount[hash] = typeof downloadCount[hash] === 'undefined' ? downloadCount[hash] + 1 : 1
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404 Not Found\n')
    }
  }
  handleRequest().catch((e) => {
    console.error(e)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('500 Internal Server Error\n')
  })
})

server.listen(PORT, HOSTNAME, (): void => {
  console.log(`Server running at http://${PUBLIC_HOSTNAME}/`)

  const handleListen = async (): Promise<void> => {
    const filesPath = path.join(DIRNAME, 'files')
    if (fs.existsSync(filesPath)) {
      const files = fs.readdirSync(filesPath)
      for (const file of files) {
        const stats = fs.statSync(path.join(filesPath, file))
        usedStorage += stats.size
      }
    }
    console.log(`Files dir size: ${usedStorage} bytes`)

    // Call all nodes and pull their /nodes
    const nodes = getNodes(false)
    for (const node of nodes) {
      try {
        if (node.http) {
          const response = await fetch(`${isIp(node.host) ? 'http' : 'https'}://${node.host}/nodes`)
          if (response.status === 200) {
            const remoteNodes = await response.json() as Node[]
            for (const remoteNode of remoteNodes) {
              if ((nodes.find((node: { host: string }) => node.host === remoteNode.host) == null) && (await downloadFromNode(remoteNode.host, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f') !== false)) nodes.push(remoteNode)
            }
          }
        }
      } catch (e) {
        console.error('Failed to fetch nodes from', node.host)
      }
    }

    fs.writeFileSync(NODES_PATH, JSON.stringify(nodes))

    await downloadFromNode(`${HOSTNAME + (PORT !== 80 && PORT !== 443 ? `:${PORT}` : '')}`, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f')
    if (!fs.existsSync(path.join(DIRNAME, 'files', '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f'))) console.error('Download test failed, cannot connect to network')
    else if (isIp(PUBLIC_HOSTNAME) && isPrivateIP(PUBLIC_HOSTNAME)) console.error('Public hostname is a private IP address, cannot announce to other nodes')
    else {
      console.log(await downloadFromNode(`${PUBLIC_HOSTNAME}`, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f'))

      // Save self to nodes.json
      if (nodes.find((node: { host: string }) => node.host === PUBLIC_HOSTNAME) == null) {
        nodes.push({ host: PUBLIC_HOSTNAME, http: true, dns: false, cf: false, hits: 0, rejects: 0 })
        fs.writeFileSync(NODES_PATH, JSON.stringify(nodes))
      }

      console.log('Announcing to nodes')
      for (const node of nodes) {
        if (node.http) {
          if (node.host === PUBLIC_HOSTNAME) continue
          console.log('Announcing to', node.host)
          await fetch(`${isIp(node.host) ? 'http' : 'https'}://${node.host}/announce?host=${PUBLIC_HOSTNAME}`)
        }
      }
    }
  }
  handleListen().catch((e) => console.error(e))
})
