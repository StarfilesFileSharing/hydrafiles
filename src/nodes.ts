import fs from 'fs'
import path from 'path'
import CONFIG from './config'
import { promiseWithTimeout, hasSufficientMemory, interfere, promiseWrapper, hashStream, bufferToStream } from './utils'
import FileHandler from './fileHandler'

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
  constructor () {
    this.nodesPath = path.join(DIRNAME, 'nodes.json')
    this.nodes = this.loadNodes()
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

  async downloadFromNode (node: Node, file: FileHandler): Promise<{ file: Buffer, signal: number } | false> {
    try {
      const startTime = Date.now()

      const hash = file.hash
      console.log(`  ${hash}  Downloading from ${node.host}`)
      const response = await promiseWithTimeout(fetch(`${node.host}/download/${hash}`), CONFIG.timeout)
      const buffer: Buffer = Buffer.from(await response.arrayBuffer())
      console.log(`  ${hash}  Validating hash`)
      const verifiedHash = await hashStream(bufferToStream(buffer))
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
      return { file: buffer, signal: interfere(Number(response.headers.get('Signal-Strength'))) }
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
      fs.writeFileSync(this.nodesPath, JSON.stringify(this.nodes))
    }
  }

  async getValidNodes (opts = { includeSelf: true }): Promise<Node[]> {
    const nodes = this.getNodes(opts)
    const results: Node[] = []
    const executing: Array<Promise<void>> = []

    for (const node of nodes) {
      if (node.host === CONFIG.public_hostname) {
        results.push(node)
        continue
      }
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
    const file = await this.downloadFromNode(node, await FileHandler.init({ hash: '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f' }))
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
    const nodes = this.getNodes({ includeSelf: false })
    let activePromises: Array<Promise<{ file: Buffer, signal: number } | false>> = []

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
        const promise = (async (): Promise<{ file: Buffer, signal: number } | false> => {
          const file = await FileHandler.init({ hash })
          const fileContent = await promiseWithTimeout(this.downloadFromNode(node, file), CONFIG.timeout)
          return fileContent !== false ? fileContent : false
        })()
        activePromises.push(promise)

        if (activePromises.length >= CONFIG.max_concurrent_nodes) {
          const file = await Promise.race(activePromises)
          if (file !== false) return file
          activePromises = activePromises.filter(p => !promiseWrapper(p).isFulfilled)
        }
      }
    }

    if (activePromises.length > 0) {
      const files = await Promise.all(activePromises)
      for (let i = 0; i < files.length; i++) {
        if (files[i] !== false) return files[i]
      }
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
