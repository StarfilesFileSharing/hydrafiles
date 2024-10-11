import { Sequelize, DataTypes, Model, ModelCtor } from 'sequelize'
import SequelizeSimpleCache, { SequelizeSimpleCacheModel } from 'sequelize-simple-cache'
import { Config } from './config'
import path from 'path'
import { fileURLToPath } from 'url'

const DIRNAME = path.dirname(fileURLToPath(import.meta.url))

const startDatabase = async (config: Config): Promise<ModelCtor<Model<any, any>> & SequelizeSimpleCacheModel<Model<any, any>>> => {
  console.log('Starting database')

  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(DIRNAME, 'filemanager.db'),
    logging: (...msg) => {
      const payload = msg[1] as unknown as { type: string, where?: string, instance: { dataValues: { hash: string } }, fields?: string[], increment: boolean }
      if (payload.type === 'SELECT') {
        if (payload.where !== undefined && config.log_level === 'verbose') console.log(`  ${payload.where.split("'")[1]}  SELECTing file from database`)
      } else if (payload.type === 'INSERT') {
        console.log(`  ${payload.instance.dataValues.hash}  INSERTing file to database`)
      } else if (payload.type === 'UPDATE') {
        if (payload.fields !== undefined) console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Changing columns: ${payload.fields.join(', ')}`)
        else if (payload.increment) console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Incrementing Value`)
        else {
          console.error('Unknown database action')
          console.log(payload)
        }
      }
    }
  })

  const UncachedFileModel = sequelize.define('File',
    {
      hash: {
        type: DataTypes.STRING,
        primaryKey: true
      },
      infohash: {
        type: DataTypes.STRING
      },
      downloadCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      id: {
        type: DataTypes.STRING
      },
      name: {
        type: DataTypes.STRING
      },
      found: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      size: {
        type: DataTypes.INTEGER
      },
      createdAt: {
        type: DataTypes.DATE
      },
      updatedAt: {
        type: DataTypes.DATE
      }
    },
    {
      tableName: 'file',
      timestamps: true,
      modelName: 'FileHandler'
    }
  )

  const cache = new SequelizeSimpleCache({ File: { ttl: 30 * 60 } })

  try {
    await sequelize.sync({ alter: true })
  } catch (e) {
    const err = e as { original: { message: string } }
    if (err.original.message.includes('file_backup')) {
      await sequelize.query('DROP TABLE IF EXISTS file_backup')
      await sequelize.sync({ alter: true })
    } else throw e
  }
  console.log('Connected to the database')
  return cache.init(UncachedFileModel)
}
export default startDatabase
