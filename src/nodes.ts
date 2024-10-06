import fs from 'fs'
import path from 'path'
import CONFIG from './config'
import { hasSufficientMemory, interfere, promiseWrapper } from './utils'
import FileManager, { File } from './file'

export interface Node { host: string, http: boolean, dns: boolean, cf: boolean, hits: number, rejects: number, bytes: number, duration: number, status?: boolean }
export enum PreferNode { FASTEST, LEAST_USED, RANDOM, HIGHEST_HITRATE }

const DIRNAME = path.resolve()

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
  nodesPath: string
  nodes: Node[]
  fileManager: FileManager
  constructor () {
    this.nodesPath = path.join(DIRNAME, 'nodes.json')
    this.nodes = this.loadNodes()
    this.fileManager = new FileManager(this)
  }

  loadNodes (): Node[] {
    return JSON.parse(fs.readFileSync(this.nodesPath).toString())
  }

  getNodes (opts = { includeSelf: true }): Node[] {
    if (opts.includeSelf === undefined) opts.includeSelf = true
    const nodes = this.nodes.filter(node => opts.includeSelf || node.host !== CONFIG.public_hostname).sort(() => Math.random() - 0.5)

    if (CONFIG.prefer_node === PreferNode.FASTEST) return nodes.sort((a: { bytes: number, duration: number }, b: { bytes: number, duration: number }) => a.bytes / a.duration - b.bytes / b.duration)
    else if (CONFIG.prefer_node === PreferNode.LEAST_USED) return nodes.sort((a: { hits: number, rejects: number }, b: { hits: number, rejects: number }) => a.hits - a.rejects - (b.hits - b.rejects))
    else if (CONFIG.prefer_node === PreferNode.HIGHEST_HITRATE) return nodes.sort((a: { hits: number, rejects: number }, b: { hits: number, rejects: number }) => (a.hits - a.rejects) - (b.hits - b.rejects))
    else return nodes
  }

  async downloadFromNode (node: Node, hash: string): Promise<File | false> {
    try {
      const startTime = Date.now()

      const host = node.host
      console.log(hash, `Downloading from ${host}`)
      const response = await fetch(`${host}/download/${hash}`)
      const arrayBuffer = await response.arrayBuffer()
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer)
      const hashArray = Array.from(new Uint8Array(hashBuffer))

      if (hash !== hashArray.map(b => b.toString(16).padStart(2, '0')).join('')) return false

      const name = String(response.headers.get('Content-Disposition')?.split('=')[1].replace(/"/g, ''))
      const signalStrength = Number(response.headers.get('Signal-Strength'))

      node.status = true
      node.duration += Date.now() - startTime
      node.bytes += arrayBuffer.byteLength
      node.hits++

      this.updateNode(node)
      return { file: Buffer.from(arrayBuffer), name, signal: interfere(signalStrength) }
    } catch (e) {
      node.rejects++

      this.updateNode(node)
      return false
    }
  }

  updateNode (node: Node): void {
    const index = this.nodes.findIndex(n => n.host === node.host)
    if (index !== -1) {
      this.nodes[index] = node
      fs.writeFileSync(this.nodesPath, JSON.stringify(this.nodes))
    }
  }

  async getValidNodes (opts = { includeSelf: true }): Promise<Node[]> {
    const nodes = this.getNodes(opts)
    const results: Node[] = []
    const executing: Array<Promise<void>> = []

    for (const node of nodes) {
      const promise = this.validateNode(node).then(result => {
        results.push(result)
        executing.splice(executing.indexOf(promise), 1)
      })
      executing.push(promise)
      if (executing.length >= CONFIG.max_concurrent_nodes) await Promise.race(executing)
    }
    await Promise.all(executing)
    return results
  }

  async validateNode (node: Node): Promise<Node> {
    const file = await this.downloadFromNode(node, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f')
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

  async getFile (hash: string, size: number = 0): Promise<File | false> {
    const nodes = this.getNodes({ includeSelf: false })
    let activePromises: Array<Promise<File | false>> = []

    if (!hasSufficientMemory(size)) {
      console.log('Reached memory limit, waiting')
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (hasSufficientMemory(size)) clearInterval(intervalId)
        }, CONFIG.memory_threshold_reached_wait)
      })
    }

    for (const node of nodes) {
      if (node.http && node.host.length > 0) {
        const promise = (async (): Promise<File | false> => {
          const file = await this.downloadFromNode(node, hash)

          if (file !== false) {
            this.fileManager.cacheFile(hash, file.file)
            return file
          } else {
            return false
          }
        })()
        activePromises.push(promise)

        if (activePromises.length >= CONFIG.max_concurrent_nodes) {
          const file = await Promise.race(activePromises)
          if (file !== false) return file

          activePromises = activePromises.filter(p => !promiseWrapper(p).isFulfilled)
        }
      }
    }

    while (activePromises.length > 0) {
      await Promise.race(activePromises)
      const file = await Promise.race(activePromises)
      if (file !== false) return file

      activePromises = activePromises.filter(p => !promiseWrapper(p).isFulfilled)
    }

    return false
  }

  async announce (): Promise<void> {
    for (const node of this.getNodes({ includeSelf: false })) {
      if (node.http) {
        if (node.host === CONFIG.public_hostname) continue
        console.log('Announcing to', node.host)
        await fetch(`${node.host}/announce?host=${CONFIG.public_hostname}`)
      }
    }
  }
}
