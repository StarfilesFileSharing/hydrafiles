import os from 'os'
import { createHash } from 'crypto'
import CONFIG from './config'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export const getRandomNumber = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min
export const isValidSHA256Hash = (hash: string): boolean => /^[a-f0-9]{64}$/.test(hash)
export const isIp = (host: string): boolean => /^https?:\/\/(?:\d+\.){3}\d+(?::\d+)?$/.test(host)
export const isPrivateIP = (ip: string): boolean => /^https?:\/\/(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255)/.test(ip)
export const interfere = (signalStrength: number): number => signalStrength >= 95 ? getRandomNumber(90, 100) : Math.ceil(signalStrength * (1 - (getRandomNumber(0, 10) / 100)))
export const hasSufficientMemory = (fileSize: number): boolean => os.freemem() > (fileSize + CONFIG.memory_threshold)
export const promiseWithTimeout = async (promise: Promise<any>, timeoutDuration: number): Promise<any> => {
  const controller = new AbortController()
  const signal = controller.signal
  const wrappedPromise = new Promise<any>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Promise timed out')))
    promise
      .then(resolve)
      .catch(reject)
  })

  return await Promise.race([
    wrappedPromise,
    new Promise((_, reject) => setTimeout(() => {
      controller.abort()
      reject(new Error('Promise timed out'))
    }, timeoutDuration))
  ])
}

export const promiseWrapper = (promise: Promise<any>): { promise: Promise<any>, isFulfilled: boolean } => {
  let isFulfilled = false
  const wrappedPromise = promise
    .then((value: any) => {
      isFulfilled = true
      return value
    })
    .catch((error: any) => {
      isFulfilled = true
      throw error
    })
  return {
    promise: wrappedPromise,
    isFulfilled
  }
}
export const estimateHops = (signalStrength: number): { hop: number | null, certainty: number } => {
  const hopData = [
    { hop: 1, min: 90, avg: 95 },
    { hop: 2, min: 81, avg: 92 },
    { hop: 3, min: 73, avg: 88 },
    { hop: 4, min: 66, avg: 85 },
    { hop: 5, min: 61, avg: 81 },
    { hop: 6, min: 56, avg: 78 },
    { hop: 7, min: 51, avg: 74 },
    { hop: 8, min: 49, avg: 71 },
    { hop: 9, min: 45, avg: 68 },
    { hop: 10, min: 43, avg: 65 }
  ]
  const avgDistance = hopData.reduce((sum, hop) => sum + Math.abs(signalStrength - hop.avg), 0) / hopData.length

  let closestHop: number | null = null
  let closestDistance: number = Infinity // Diff between signal strength and avg
  let closestCertainty: number = Infinity

  for (const hop of hopData) {
    if (signalStrength < hop.min) continue
    const distance = Math.abs(signalStrength - hop.avg)
    const range = 100 - hop.min
    const distanceMinMax = Math.min(Math.abs(signalStrength - hop.min), Math.abs(100 - signalStrength))
    const certaintyAvg = avgDistance > 0 ? (1 - (distance / avgDistance)) : 0
    // const certaintyAvg = range > 0 ? (1 - (distance / (range / 2))) : 0
    const certaintyMinMax = 1 - (distanceMinMax / Math.max(range, 1))
    const finalCertainty = (certaintyAvg + certaintyMinMax) / 2
    if (distance < closestDistance) {
      closestDistance = distance
      closestHop = hop.hop
      closestCertainty = finalCertainty
    }
  }

  return { hop: closestHop, certainty: Math.round(closestCertainty * 10000) / 100 }
}

export const hashStream = async (stream: Readable): Promise<string> => {
  const hash = createHash('sha256')

  await pipeline(stream, async function * (source) {
    for await (const chunk of source) {
      hash.update(chunk)
    }
  })

  return hash.digest('hex')
}

export async function streamLength (stream: Readable): Promise<number> {
  const chunks: Buffer[] = []

  await pipeline(stream, async function * (source) {
    for await (const chunk of source) {
      chunks.push(chunk)
    }
  })

  const completeBuffer = Buffer.concat(chunks)
  return completeBuffer.buffer.slice(completeBuffer.byteOffset, completeBuffer.byteOffset + completeBuffer.byteLength).byteLength
}

export async function streamToBuffer (stream: Readable): Promise<ArrayBuffer> {
  const chunks: Buffer[] = []

  await pipeline(stream, async function * (source) {
    for await (const chunk of source) {
      chunks.push(chunk)
    }
  })

  const completeBuffer = Buffer.concat(chunks)
  return completeBuffer.buffer.slice(completeBuffer.byteOffset, completeBuffer.byteOffset + completeBuffer.byteLength)
}

export function bufferToStream (arrayBuffer: ArrayBuffer): Readable {
  const buffer = Buffer.from(arrayBuffer)
  const readable = new Readable({
    read () {
      this.push(buffer)
      this.push(null)
    }
  })
  return readable
}
