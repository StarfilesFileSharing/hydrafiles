import fs from 'fs'
import http from 'http'
import path from 'path'
import formidable from 'formidable'
import CONFIG from './config.js'
import { nodeFrom, NODES_PATH, nodesManager } from './nodes.js'
import FileHandler, { FileAttributes, FileModel } from './fileHandler.js'
import { estimateHops, isIp, isPrivateIP } from './utils.js'

const DIRNAME = path.resolve()
export const hashLocks = new Map<string, Promise<any>>()

const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse<http.IncomingMessage>): Promise<void> => {
  try {
    if (req.url === '/' || req.url === null || typeof req.url === 'undefined') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=604800' })
      fs.createReadStream('public/index.html').pipe(res)
    } else if (req.url === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=604800' })
      fs.createReadStream('public/favicon.ico').pipe(res)
    } else if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: true }))
    } else if (req.url === '/nodes' || req.url.startsWith('/nodes?')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' })
      res.end(JSON.stringify(await nodesManager.getValidNodes()))
    } else if (req.url.startsWith('/announce')) {
      const params = Object.fromEntries(new URLSearchParams(req.url.split('?')[1]))
      const host = params.host

      const nodes = nodesManager.getNodes()
      if (nodes.find((node) => node.host === host) != null) {
        res.end('Already known\n')
        return
      }

      if (await nodesManager.downloadFromNode(nodeFrom(host), await FileHandler.init({ hash: '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f' })) !== false) {
        nodesManager.nodes.push({ host, http: true, dns: false, cf: false, hits: 0, rejects: 0, bytes: 0, duration: 0 })
        fs.writeFileSync(NODES_PATH, JSON.stringify(nodes))
        res.end('Announced\n')
      } else res.end('Invalid request\n')
    } else if (req.url?.startsWith('/download/')) {
      const hash = req.url.split('/')[2]
      const fileId = req.url.split('/')[3] ?? ''

      while (hashLocks.has(hash)) {
        if (CONFIG.log_level === 'verbose') console.log(`  ${hash}  Waiting for existing request with same hash`)
        await hashLocks.get(hash)
      }
      const processingPromise = (async () => {
        const file = await FileHandler.init({ hash })

        if (fileId.length !== 0) {
          const id = file.id
          if (id === undefined || id === null || id.length === 0) {
            file.id = fileId
            await file.save()
          }
        }

        await file.getMetadata()
        let fileContent: { file: Buffer, signal: number } | false
        try {
          fileContent = await file.getFile(nodesManager)
        } catch (e) {
          const err = e as { message: string }
          if (err.message === 'Promise timed out') fileContent = false
          else throw e
        }

        if (fileContent === false) {
          file.found = false
          await file.save()
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('404 File Not Found\n')
          return
        }

        const headers: { [key: string]: string } = {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000'
        }

        headers['Signal-Strength'] = String(fileContent.signal)
        console.log(`  ${hash}  Signal Strength:`, fileContent.signal, estimateHops(fileContent.signal))

        headers['Content-Length'] = String(file.size)
        headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(file.name ?? 'File').replace(/%20/g, ' ').replace(/(\.\w+)$/, ' [HYDRAFILES]$1')}"`

        res.writeHead(200, headers)
        res.end(fileContent.file)
      })()

      hashLocks.set(hash, processingPromise)

      try {
        await processingPromise
      } finally {
        hashLocks.delete(hash)
      }
    } else if (req.url?.startsWith('/infohash/')) {
      const infohash = req.url.split('/')[2]

      while (hashLocks.has(infohash)) {
        console.log(`  ${infohash}  Waiting for existing request with same infohash`)
        await hashLocks.get(infohash)
      }
      const processingPromise = (async () => {
        const file = await FileHandler.init({ infohash })

        await file.getMetadata()
        let fileContent: { file: Buffer, signal: number } | false
        try {
          fileContent = await file.getFile(nodesManager)
        } catch (e) {
          const err = e as { message: string }
          if (err.message === 'Promise timed out') fileContent = false
          else throw e
        }

        if (fileContent === false) {
          file.found = false
          await file.save()
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('404 File Not Found\n')
          return
        }

        const headers: { [key: string]: string } = {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000'
        }

        headers['Signal-Strength'] = String(fileContent.signal)
        console.log(`  ${file.hash}  Signal Strength:`, fileContent.signal, estimateHops(fileContent.signal))

        headers['Content-Length'] = String(file.size)
        headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(file.name ?? 'File').replace(/%20/g, ' ').replace(/(\.\w+)$/, ' [HYDRAFILES]$1')}"`

        res.writeHead(200, headers)
        res.end(fileContent.file)
      })()

      hashLocks.set(infohash, processingPromise)

      try {
        await processingPromise
      } finally {
        hashLocks.delete(infohash)
      }
    } else if (req.url === '/upload') {
      const uploadSecret = req.headers['x-hydra-upload-secret']
      if (uploadSecret !== CONFIG.upload_secret) {
        res.writeHead(401, { 'Content-Type': 'text/plain' })
        res.end('401 Unauthorized\n')
        return
      }

      const form = formidable({})
      form.parse(req, (err: unknown, fields: formidable.Fields, files: formidable.Files) => {
        if (err !== undefined && err !== null) {
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
        const uploadedFile = files.file[0]

        FileHandler.init({ hash }).then(async file => {
          let name = file.name
          if ((name === undefined || name === null || name.length === 0) && uploadedFile.originalFilename !== null) {
            name = uploadedFile.originalFilename
            file.name = name
            await file.cacheFile(fs.readFileSync(uploadedFile.filepath))
            await file.save()
          }
        }).catch(console.error)

        console.log('Uploading', hash)

        if (fs.existsSync(path.join(DIRNAME, 'files', hash))) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('200 OK\n')
          return
        }

        if (!CONFIG.perma_files.includes(hash)) CONFIG.perma_files.push(hash)
        fs.writeFileSync(path.join(DIRNAME, 'config.json'), JSON.stringify(CONFIG, null, 2))

        res.writeHead(201, { 'Content-Type': 'text/plain' })
        res.end('200 OK\n')
      })
    } else if (req.url === '/files') {
      const rows = (await FileModel.findAll()).map((row: { dataValues: FileAttributes }) => {
        const { hash, infohash, id, name, size } = row.dataValues
        return { hash, infohash, id, name, size }
      })
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10800' })
      res.end(JSON.stringify(rows))
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404 Page Not Found\n')
    }
  } catch (e) {
    console.error(e)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error')
  }
}

export const startServer = (): void => {
  const server = http.createServer((req, res) => {
    console.log('Request Received:', req.url)

    handleRequest(req, res).catch(console.error)
  })

  server.listen(CONFIG.port, CONFIG.hostname, (): void => {
    console.log(`Server running at ${CONFIG.public_hostname}/`)

    const handleListen = async (): Promise<void> => {
      console.log('Testing network connection')
      const file = await nodesManager.getFile('04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f')
      if (file === false) console.error('Download test failed, cannot connect to network')
      else {
        console.log('Connected to network')

        if (isIp(CONFIG.public_hostname) && isPrivateIP(CONFIG.public_hostname)) console.error('Public hostname is a private IP address, cannot announce to other nodes')
        else {
          console.log(`Testing downloads ${CONFIG.public_hostname}/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f`)

          console.log('Testing connectivity')
          const response = await nodesManager.downloadFromNode(nodeFrom(`${CONFIG.public_hostname}`), await FileHandler.init({ hash: '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f' }))
          if (response === false) console.error('  04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f  ERROR: Failed to download file from self')
          else {
            console.log('  04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f  Test Succeeded')
            console.log('Announcing to nodes')
            await nodesManager.announce()
          }
          await nodesManager.add({ host: CONFIG.public_hostname, http: true, dns: false, cf: false, hits: 0, rejects: 0, bytes: 0, duration: 0 })
        }
      }
    }
    handleListen().catch(console.error)
  })
}