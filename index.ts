import http from 'http'
import fs from 'fs'
import path from 'path'
// import fetch from 'node-fetch'
import crypto from 'crypto'
import { S3 } from '@aws-sdk/client-s3'
import { Readable } from 'stream'
import formidable from 'formidable'

const DIRNAME = path.resolve()

// ADVANCED CONFIG ////////////////////////////
let NODES_PATH = path.join(DIRNAME, 'nodes.json')
// ADVANCED CONFIG ////////////////////////////

// TYPES //////////////////////////////////////
interface Metadata {name: string, size: string, type: string, hash: string, id: string}
interface ResponseHeaders { [key: string]: string }
type File = { file: Buffer, name?: string } | false
interface Node { host: string, http: boolean, dns: boolean, cf: boolean, hits: number, rejects: number, bytes: number, duration: number }
enum PreferNode { FASTEST, LEAST_USED, RANDOM, HIGHEST_HITRATE }
interface FileTable { [key: string]: { id?: string, name?: string } }
// TYPES //////////////////////////////////////

// CONFIG /////////////////////////////////////
if (!fs.existsSync(path.join(DIRNAME, 'config.json'))) fs.copyFileSync(path.join(DIRNAME, 'config.default.json'), path.join(DIRNAME, 'config.json'))

const config = JSON.parse(fs.readFileSync(path.join(DIRNAME, 'config.json')).toString())
const PORT: number = config.port
const HOSTNAME: string = config.hostname
const MAX_STORAGE = config.max_storage
const PERMA_FILES: string[] = config.perma_files
const BURN_RATE = config.burn_rate
const METADATA_ENDPOINT: string = config.metadata_endpoint
const BOOTSTRAP_NODES = config.bootstrap_nodes
const PUBLIC_HOSTNAME: string = config.public_hostname
const PREFER_NODE = config.prefer_node
const UPLOAD_SECRET = config.upload_secret || Math.random().toString(36).substring(2, 15)
if (config.nodes_path !== undefined) NODES_PATH = config.nodes_path

const S3ACCESSKEYID = config.s3_access_key_id
const S3SECRETACCESSKEY = config.s3_secret_access_key
const S3ENDPOINT = config.s3_endpoint
const CACHE_S3 = config.cache_s3
// CONFIG /////////////////////////////////////

// INITIALISATION /////////////////////////////
if (!fs.existsSync(path.join(DIRNAME, 'files'))) fs.mkdirSync(path.join(DIRNAME, 'files'))
if (!fs.existsSync(path.join(DIRNAME, 'nodes.json'))) fs.writeFileSync(path.join(DIRNAME, 'nodes.json'), JSON.stringify(BOOTSTRAP_NODES))
if (!fs.existsSync(path.join(DIRNAME, 'filetable.json'))) fs.writeFileSync(path.join(DIRNAME, 'filetable.json'), JSON.stringify({}))
if (config.upload_secret === undefined) {
  config.upload_secret = UPLOAD_SECRET
  fs.writeFileSync(path.join(DIRNAME, 'config.json'), JSON.stringify(config, null, 2))
}
// INITIALISATION /////////////////////////////

const isIp = (host: string): boolean => /(?:\d+\.){3}\d+(?::\d+)?/.test(host)
const isPrivateIP = (ip: string): boolean => /^(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255)/.test(ip)

let usedStorage = 0
const downloadCount: { [key: string]: number } = {}
const preferNode = PreferNode[PREFER_NODE as keyof typeof PreferNode] || PreferNode.FASTEST
const fileTable: FileTable = JSON.parse(fs.readFileSync(path.join(DIRNAME, 'filetable.json')).toString())

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

const getNodes = (opts = { includeSelf: true }): Node[] => {
  if (opts.includeSelf === undefined) opts.includeSelf = true

  const nodes = JSON.parse(fs.readFileSync(NODES_PATH).toString())
    .filter((node: { host: string }) => opts.includeSelf || node.host !== PUBLIC_HOSTNAME)
    .sort(() => Math.random() - 0.5)

  if (preferNode === PreferNode.FASTEST) return nodes.sort((a: { bytes: number, duration: number }, b: { bytes: number, duration: number }) => a.bytes / a.duration - b.bytes / b.duration)
  else if (preferNode === PreferNode.LEAST_USED) return nodes.sort((a: { hits: number, rejects: number }, b: { hits: number, rejects: number }) => a.hits - a.rejects - (b.hits - b.rejects))
  else if (preferNode === PreferNode.HIGHEST_HITRATE) return nodes.sort((a: { hits: number, rejects: number }, b: { hits: number, rejects: number }) => (a.hits - a.rejects) - (b.hits - b.rejects))
  else return nodes
}

const getValidNodes = async (opts = { includeSelf: true }): Promise<Node[]> => {
  const nodes = getNodes(opts)
  return nodes.filter(async node => await downloadFromNode(node.host, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f') !== false)
}

const downloadFromNode = async (host: string, hash: string): Promise<File> => {
  try {
    console.log(`${isIp(host) ? 'http' : 'https'}://${host}/download/${hash}`)
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

  if (S3ENDPOINT.length > 0) {
    const s3File = await fetchFromS3('uploads', `${hash}.stuf`)
    if (s3File !== false) {
      if (CACHE_S3) cacheFile(filePath, s3File.file)
      return s3File
    }
  }

  for (const node of getNodes({ includeSelf: false })) {
    if (node.http && node.host.length > 0) {
      const startTime = Date.now()
      const file = await downloadFromNode(node.host, hash)
      if (file !== false) {
        node.duration += Date.now() - startTime
        node.bytes += file.file.length

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

const setFiletable = (hash: string, id: string | undefined, name: string | undefined): void => {
  if (typeof fileTable[hash] === 'undefined') fileTable[hash] = {}
  if (typeof id !== 'undefined') fileTable[hash].id = id
  if (typeof name !== 'undefined') fileTable[hash].name = name
  fs.writeFileSync(path.join(DIRNAME, 'filetable.json'), JSON.stringify(fileTable, null, 2))
}

const server = http.createServer((req, res) => {
  console.log('  Request Received:', req.url)

  const handleRequest = async (): Promise<void> => {
    if (req.url === '/' || req.url === null || typeof req.url === 'undefined') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=604800' })
      fs.createReadStream('index.html').pipe(res)
    } else if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: true }))
    } else if (req.url === '/nodes' || req.url.startsWith('/nodes?')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' })

      const nodes = await getValidNodes()
      res.end(JSON.stringify(nodes))
    } else if (req.url.startsWith('/announce')) {
      const params = Object.fromEntries(new URLSearchParams(req.url.split('?')[1]))
      const host = params.host

      const nodes = getNodes()
      if (nodes.find((node) => node.host === host) != null) {
        res.end('Already known\n')
        return
      }

      if (await downloadFromNode(host, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f') !== false) {
        nodes.push({ host, http: true, dns: false, cf: false, hits: 0, rejects: 0, bytes: 0, duration: 0 })
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
      if (typeof fileId !== 'undefined') {
        const response = await fetch(`${METADATA_ENDPOINT}${fileId}`)
        if (response.status === 200) name = (await response.json() as Metadata).name
      }

      name = typeof name !== 'undefined' ? name : (file.name ?? fileTable[hash]?.name)
      headers['Content-Length'] = file.file.length.toString()
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(name ?? 'File').replace(/%20/g, ' ')}"`

      setFiletable(hash, fileId, name)

      res.writeHead(200, headers)
      res.end(file.file)
      downloadCount[hash] = typeof downloadCount[hash] === 'undefined' ? downloadCount[hash] + 1 : 1
    } else if (req.url === '/upload') {
      const uploadSecret = req.headers['x-hydra-upload-secret']
      if (uploadSecret !== UPLOAD_SECRET) {
        res.writeHead(401, { 'Content-Type': 'text/plain' })
        res.end('401 Unauthorized\n')
        return
      }

      const form = formidable({})
      form.parse(req, (err: unknown, fields: formidable.Fields, files: formidable.Files) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('500 Internal Server Error\n')
          return
        }

        if (typeof fields.hash === 'undefined' || typeof files.file === 'undefined') {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('400 Bad Request\n')
          return
        }

        const hash = fields.hash[0]
        const file = files.file[0]

        setFiletable(hash, undefined, file.originalFilename as string)

        console.log('Uploading', hash)

        const filePath = path.join(DIRNAME, 'files', hash)
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('200 OK\n')
          return
        }

        if (!PERMA_FILES.includes(hash)) {
          PERMA_FILES.push(hash)
          config.perma_files = PERMA_FILES
        }

        fs.writeFileSync(path.join(DIRNAME, 'config.json'), JSON.stringify(config, null, 2))

        cacheFile(filePath, fs.readFileSync(file.filepath))

        res.writeHead(201, { 'Content-Type': 'text/plain' })
        res.end('200 OK\n')
      })
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404 Not Found\n')
    }
  }
  handleRequest().catch((e) => console.error(e))
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
    const nodes = getNodes({ includeSelf: false })
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
        nodes.push({ host: PUBLIC_HOSTNAME, http: true, dns: false, cf: false, hits: 0, rejects: 0, bytes: 0, duration: 0 })
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
