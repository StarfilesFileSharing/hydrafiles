import os from 'os'
import CONFIG from './config'

export const getRandomNumber = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min
export const isValidSHA256Hash = (hash: string): boolean => /^[a-f0-9]{64}$/.test(hash)
export const isIp = (host: string): boolean => /^https?:\/\/(?:\d+\.){3}\d+(?::\d+)?$/.test(host)
export const isPrivateIP = (ip: string): boolean => /^https?:\/\/(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255)/.test(ip)
export const interfere = (signalStrength: number): number => signalStrength >= 95 ? getRandomNumber(90, 100) : Math.ceil(signalStrength * (1 - (getRandomNumber(0, 10) / 100)))
export const hasSufficientMemory = (fileSize: number): boolean => os.freemem() > (fileSize + CONFIG.memory_threshold)
export const promiseWithTimeout = async (promise: Promise<any>, timeoutDuration: number): Promise<any> => await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Promise timed out')), timeoutDuration)
  promise
    .then(result => {
      clearTimeout(timeout)
      resolve(result)
    })
    .catch(error => {
      clearTimeout(timeout)
      reject(error)
    })
})
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
export const estimateNumberOfHopsWithRandomAndCertainty = (signalStrength: number): { estimatedHops: number, certaintyPercentage: number } => {
  const interference = 0.1

  const numerator = 2 * signalStrength - 100
  if (numerator <= 0) throw new Error('Invalid average signal strength for the given initial signal strength.')
  const numberOfHops = Math.log(numerator / 100) / Math.log(1 - interference)

  let worstCaseSignal = 100
  for (let i = 0; i < Math.ceil(numberOfHops); i++) {
    worstCaseSignal *= (1 - interference)
    if (worstCaseSignal >= 95) worstCaseSignal = getRandomNumber(90, 100)
  }

  return {
    estimatedHops: Math.ceil(numberOfHops),
    certaintyPercentage: Number(worstCaseSignal.toFixed(2))
  }
}
