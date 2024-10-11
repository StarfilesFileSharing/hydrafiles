import fs from 'fs'
import path from 'path'
import Hydrafiles from './hydrafiles.js'
import { fileURLToPath } from 'url'
import { Config } from './config.js'

const DIRNAME = path.dirname(fileURLToPath(import.meta.url))

if (!fs.existsSync(path.join(DIRNAME, '../config.json'))) fs.writeFileSync(path.join(DIRNAME, '../config.json'), '{}')
const config: Config = JSON.parse(fs.readFileSync(path.join(DIRNAME, '../config.json')).toString())

const hydrafiles = new Hydrafiles(config)
export default hydrafiles
console.log('Hydrafiles Started', hydrafiles)
