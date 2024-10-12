import fs from 'fs'
import FileHandler from './fileHandler.js'
import path from 'path'
import { fileURLToPath } from 'url'
import Hydrafiles from './hydrafiles.js'

export interface Node { host: string, http: boolean, dns: boolean, cf: boolean, hits: number, rejects: number, bytes: number, duration: number, status?: boolean }

const DIRNAME = path.dirname(fileURLToPath(import.meta.url))
export const NODES_PATH = path.join(DIRNAME, '../nodes.json')

export const nodeFrom = (host: string): Node => {
  const node: Node = {
    host,
    http: true,
    dns: false,
    cf: false,
    hits: 0,
    rejects: 0,
    bytes: 0,
    duration: 0
  }
  return node
}

export default class Nodes {
  nodes: Node[]
  client
  constructor (client: Hydrafiles) {
    this.nodes = this.loadNodes()
    this.client = client
  }

  async add (node: Node): Promise<void> {
    if (node.host !== this.client.config.public_hostname && typeof this.nodes.find((existingNode) => existingNode.host === node.host) === 'undefined' && (await this.downloadFromNode(node, await FileHandler.init({ hash: '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f' }, this.client)) !== false)) {
      this.nodes.push(node)
      fs.writeFileSync(NODES_PATH, JSON.stringify(this.nodes))
    }
  }

  loadNodes (): Node[] {
    return JSON.parse(fs.existsSync(NODES_PATH) ? fs.readFileSync(NODES_PATH).toString() : '[]')
  }

  getNodes (opts = { includeSelf: true }): Node[] {
    if (opts.includeSelf === undefined) opts.includeSelf = true
    const nodes = this.nodes.filter(node => opts.includeSelf || node.host !== this.client.config.public_hostname).sort(() => Math.random() - 0.5)

    if (this.client.config.prefer_node === 'FASTEST') return nodes.sort((a: { bytes: number, duration: number }, b: { bytes: number, duration: number }) => a.bytes / a.duration - b.bytes / b.duration)
    else if (this.client.config.prefer_node === 'LEAST_USED') return nodes.sort((a: { hits: number, rejects: number }, b: { hits: number, rejects: number }) => a.hits - a.rejects - (b.hits - b.rejects))
    else if (this.client.config.prefer_node === 'HIGHEST_HITRATE') return nodes.sort((a: { hits: number, rejects: number }, b: { hits: number, rejects: number }) => (a.hits - a.rejects) - (b.hits - b.rejects))
    else return nodes
  }

  async downloadFromNode (node: Node, file: FileHandler): Promise<{ file: Buffer, signal: number } | false> {
    try {
      const startTime = Date.now()

      const hash = file.hash
      console.log(`  ${hash}  Downloading from ${node.host}`)
      let response
      try {
        response = await this.client.utils.promiseWithTimeout(fetch(`${node.host}/download/${hash}`), this.client.config.timeout)
      } catch (e) {
        if (this.client.config.log_level === 'verbose') console.error(e)
        return false
      }
      const buffer: Buffer = Buffer.from(await response.arrayBuffer())
      console.log(`  ${hash}  Validating hash`)
      const verifiedHash = await this.client.utils.hashStream(this.client.utils.bufferToStream(buffer))
      if (hash !== verifiedHash) return false

      if (file.name === undefined || file.name === null || file.name.length === 0) {
        file.name = String(response.headers.get('Content-Disposition')?.split('=')[1].replace(/"/g, '').replace(' [HYDRAFILES]', ''))
        await file.save()
      }

      node.status = true
      node.duration += Date.now() - startTime
      node.bytes += buffer.byteLength
      node.hits++
      this.updateNode(node)

      await file.cacheFile(buffer)
      return { file: buffer, signal: this.client.utils.interfere(Number(response.headers.get('Signal-Strength'))) }
    } catch (e) {
      console.error(e)
      node.rejects++

      this.updateNode(node)
      return false
    }
  }

  updateNode (node: Node): void {
    const index = this.nodes.findIndex(n => n.host === node.host)
    if (index !== -1) {
      this.nodes[index] = node
      fs.writeFileSync(NODES_PATH, JSON.stringify(this.nodes))
    }
  }

  async getValidNodes (opts = { includeSelf: true }): Promise<Node[]> {
    const nodes = this.getNodes(opts)
    const results: Node[] = []
    const executing: Array<Promise<void>> = []

    for (const node of nodes) {
      if (node.host === this.client.config.public_hostname) {
        results.push(node)
        continue
      }
      const promise = this.validateNode(node).then(result => {
        results.push(result)
        executing.splice(executing.indexOf(promise), 1)
      })
      executing.push(promise)
    }
    await Promise.all(executing)
    return results
  }

  async validateNode (node: Node): Promise<Node> {
    const file = await this.downloadFromNode(node, await FileHandler.init({ hash: '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f' }, this.client))
    if (file !== false) {
      node.status = true
      this.updateNode(node)
      return node
    } else {
      node.status = false
      this.updateNode(node)
      return node
    }
  }

  async getFile (hash: string, size: number = 0): Promise<{ file: Buffer, signal: number } | false> {
    console.log(`  ${hash}  Getting file from nodes`)
    const nodes = this.getNodes({ includeSelf: false })
    const activePromises: Array<Promise<{ file: Buffer, signal: number } | false>> = []

    if (!this.client.utils.hasSufficientMemory(size)) {
      console.log('Reached memory limit, waiting')
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (this.client.utils.hasSufficientMemory(size)) clearInterval(intervalId)
        }, this.client.config.memory_threshold_reached_wait)
      })
    }

    for (const node of nodes) {
      if (node.http && node.host.length > 0) {
        const promise = (async (): Promise<{ file: Buffer, signal: number } | false> => {
          const file = await FileHandler.init({ hash }, this.client)
          let fileContent: { file: Buffer, signal: number } | false = false
          try {
            fileContent = await this.downloadFromNode(node, file)
          } catch (e) {
            console.error(e)
          }
          return fileContent !== false ? fileContent : false
        })()
        activePromises.push(promise)
      }
    }

    const files = await Promise.all(activePromises)
    for (let i = 0; i < files.length; i++) {
      if (files[i] !== false) return files[i]
    }

    return false
  }

  async announce (): Promise<void> {
    for (const node of this.getNodes({ includeSelf: false })) {
      if (node.http) {
        if (node.host === this.client.config.public_hostname) continue
        console.log('Announcing to', node.host)
        await fetch(`${node.host}/announce?host=${this.client.config.public_hostname}`)
      }
    }
  }

  async compareFileList (node: Node): Promise<void> { // TODO: Compare list between all nodes and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
    try {
      console.log(`Comparing file list with ${node.host}`)
      const response = await fetch(`${node.host}/files`)
      const files = await response.json() as Array<{ hash: string, infohash: string | null, id: string | null, name: string | null, size: number }>
      for (let i = 0; i < files.length; i++) {
        try {
          const file = await FileHandler.init({ hash: files[i].hash, infohash: files[i].infohash ?? undefined }, this.client)
          if (file.infohash?.length === 0 && files[i].infohash?.length !== 0) file.infohash = files[i].infohash
          if (file.id?.length === 0 && files[i].id?.length !== 0) file.id = files[i].id
          if (file.name?.length === 0 && files[i].name?.length !== 0) file.name = files[i].name
          if (file.size === 0 && files[i].size !== 0) file.size = files[i].size
          await file.save()
        } catch (e) {
          console.error(e)
        }
      }
    } catch (e) {
      const err = e as { message: string }
      console.error(`Failed to compare file list with ${node.host} - ${err.message}`)
      return
    }
    console.log(`Done comparing file list with ${node.host}`)
  }

  async compareNodeList (): Promise<void> { // TODO: Compare list between all nodes and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
    console.log('Comparing node list')
    const nodes = this.getNodes({ includeSelf: false })
    for (const node of nodes) {
      (async () => {
        if (node.host.startsWith('http://') || node.host.startsWith('https://')) {
          console.log(`Fetching nodes from ${node.host}/nodes`)
          try {
            const response = await this.client.utils.promiseWithTimeout(fetch(`${node.host}/nodes`), this.client.config.timeout)
            const remoteNodes = await response.json() as Node[]
            for (const remoteNode of remoteNodes) {
              this.add(remoteNode).catch((e) => {
                if (this.client.config.log_level === 'verbose') console.error(e)
              })
            }
          } catch (e) {
            if (this.client.config.log_level === 'verbose') throw e
          }
        }
      })().catch(console.error)
    }
  }
}
