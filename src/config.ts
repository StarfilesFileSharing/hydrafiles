import fs from 'fs'
import path from 'path'
import { PreferNode } from './nodes'

export interface Config {
  port: number
  hostname: string
  max_storage: number
  perma_files: string[]
  burn_rate: number
  metadata_endpoint: string
  bootstrap_nodes: string[]
  public_hostname: string
  prefer_node: PreferNode
  max_concurrent_nodes: number
  upload_secret: string
  s3_access_key_id: string
  s3_secret_access_key: string
  s3_endpoint: string
  cache_s3: boolean
  memory_threshold: number
  memory_threshold_reached_wait: number
  timeout: number
  log_level: 'verbose' | 'normal'
}

const DIRNAME = path.resolve()

if (!fs.existsSync(path.join(DIRNAME, 'config.json'))) fs.copyFileSync(path.join(DIRNAME, 'config.default.json'), path.join(DIRNAME, 'config.json'))
const config: Config = JSON.parse(fs.readFileSync(path.join(DIRNAME, 'config.json')).toString())

const CONFIG: Config = {
  port: config.port,
  hostname: config.hostname,
  max_storage: config.max_storage,
  perma_files: config.perma_files,
  burn_rate: config.burn_rate,
  metadata_endpoint: config.metadata_endpoint,
  bootstrap_nodes: config.bootstrap_nodes,
  public_hostname: config.public_hostname,
  prefer_node: config.prefer_node,
  max_concurrent_nodes: config.max_concurrent_nodes,
  upload_secret: config.upload_secret,
  s3_access_key_id: config.s3_access_key_id,
  s3_secret_access_key: config.s3_secret_access_key,
  s3_endpoint: config.s3_endpoint,
  cache_s3: config.cache_s3,
  memory_threshold: config.memory_threshold,
  memory_threshold_reached_wait: config.memory_threshold_reached_wait,
  timeout: config.timeout,
  log_level: config.log_level
}

export default CONFIG
