import fs from 'fs'
import path from 'path'
import { Config } from './config.js'
import { NODES_PATH } from './nodes.js'

const DIRNAME = path.resolve()

function init (config: Config): void {
  if (!fs.existsSync(path.join(DIRNAME, 'files'))) fs.mkdirSync(path.join(DIRNAME, 'files'))
  if (!fs.existsSync(NODES_PATH)) fs.writeFileSync(NODES_PATH, JSON.stringify(config.bootstrap_nodes))
}

export default init
