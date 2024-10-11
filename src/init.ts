import fs from 'fs'
import path from 'path'
import { Config } from './config.js'

const DIRNAME = path.resolve()

function init (config: Config): void {
  if (!fs.existsSync(path.join(DIRNAME, 'files'))) fs.mkdirSync(path.join(DIRNAME, 'files'))
  if (!fs.existsSync(path.join(DIRNAME, 'nodes.json'))) fs.writeFileSync(path.join(DIRNAME, 'nodes.json'), JSON.stringify(config.bootstrap_nodes))
}

export default init
