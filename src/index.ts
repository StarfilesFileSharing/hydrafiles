import fs from 'fs'
import CONFIG from './config'
import init from './init'
import { nodesManager } from './nodes'
import FileHandler, { FileModel, startDatabase, webtorrent } from './fileHandler'
import { calculateUsedStorage } from './utils'
import { Sequelize } from 'sequelize'
import { hashLocks, startServer } from './server'

// TODO: IDEA: HydraTorrent - New Github repo - "Hydrafiles + WebTorrent Compatibility Layer" - Hydrafiles noes can optionally run HydraTorrent to seed files via webtorrent
// Change index hash from sha256 to infohash, then allow nodes to leech files from webtorrent + normal torrent
// HydraTorrent is a WebTorrent hybrid client that plugs into Hydrafiles
// Then send a PR to WebTorrent for it to connect to the Hydrafiles network as default webseeds
// HydraTorrent is 2-way, allowing for fetching-seeding files via both hydrafiles and torrent
//
// ALSO THIS ALLOWS FOR PLAUSIBLE DENIABLITY FOR NORMAL TORRENTS
// Torrent clients can connect to the Hydrafiles network and claim they dont host any of the files they seed
// bittorrent to http proxy
// starfiles.co would use webtorrent to download files

console.log('Hydrafiles Starting')

init()

const startTime = +new Date()

function convertTime (duration: number): string {
  const msPerSecond = 1000
  const msPerMinute = msPerSecond * 60
  const msPerHour = msPerMinute * 60
  const msPerDay = msPerHour * 24

  if (duration < msPerMinute) return (duration / msPerSecond).toFixed(2) + ' seconds'
  else if (duration < msPerHour) return (duration / msPerMinute).toFixed(2) + ' minutes'
  else if (duration < msPerDay) return (duration / msPerHour).toFixed(2) + ' hours'
  else return (duration / msPerDay).toFixed(2) + ' days'
}

function stateSummary (): void {
  (async () => {
    console.log('\n===============================================\n========', new Date().toUTCString(), '========\n===============================================\n| Uptime: ', convertTime(+new Date() - startTime), '\n| Known (Network) Files:', await FileModel.noCache().count(), `(${Math.round((100 * await FileModel.noCache().sum('size')) / 1024 / 1024 / 1024) / 100}GB)`, '\n| Stored Files:', fs.readdirSync('files/').length, `(${Math.round((100 * calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`, '\n| Processing Files:', hashLocks.size, '\n| Seeding Torrent Files:', webtorrent.torrents.length, '\n| Download Count:', await FileModel.noCache().sum('downloadCount'), '\n===============================================\n')
  })().catch(console.error)
}
stateSummary()
setInterval(stateSummary, CONFIG.summary_speed);

(async () => {
  await startDatabase()
  startServer()
})().catch(console.error)

const backgroundTasks = async (): Promise<void> => {
  nodesManager.compareNodeList().catch(console.error);
  (async () => {
    for (let i = 0; i < nodesManager.getNodes({ includeSelf: false }).length; i++) {
      await nodesManager.compareFileList(nodesManager.nodes[i])
    }
  })().catch(console.error)
}

setInterval(() => {
  backgroundTasks().catch(console.error)
}, CONFIG.compare_speed)
backgroundTasks().catch(console.error)

async function backfillFiles (): Promise<void> {
  const files = await FileModel.findAll({ order: Sequelize.literal('RANDOM()') })
  for (let i = 0; i < files.length; i++) {
    const hash: string = files[i].dataValues.hash
    console.log(`  ${hash}  Backfilling file`)
    const file = await FileHandler.init({ hash })
    try {
      await file.getFile(nodesManager, { logDownloads: false }).catch((e) => { if (CONFIG.log_level === 'verbose') console.error(e) })
    } catch (e) {
      if (CONFIG.log_level === 'verbose') throw e
    }
  }
  backfillFiles().catch(console.error)
}
if (CONFIG.backfill) backfillFiles().catch(console.error)
