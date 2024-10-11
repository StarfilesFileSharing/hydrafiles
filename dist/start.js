import fs from 'fs';
import Hydrafiles from './hydrafiles.js';
import path from 'path';
import { fileURLToPath } from 'url';
const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
if (!fs.existsSync(path.join(DIRNAME, '../config.json')))
    fs.writeFileSync(path.join(DIRNAME, '../config.json'), '{}');
const config = JSON.parse(fs.readFileSync(path.join(DIRNAME, '../config.json')).toString());
const hydrafiles = new Hydrafiles(config);
export default hydrafiles;
console.log('Hydrafiles Started', hydrafiles);
