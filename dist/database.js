var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { Sequelize, DataTypes } from 'sequelize';
import SequelizeSimpleCache from 'sequelize-simple-cache';
import path from 'path';
const DIRNAME = path.resolve();
const startDatabase = (config) => __awaiter(void 0, void 0, void 0, function* () {
    console.log('Starting database');
    const sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: path.join(DIRNAME, 'filemanager.db'),
        logging: (...msg) => {
            const payload = msg[1];
            if (payload.type === 'SELECT') {
                if (payload.where !== undefined && config.log_level === 'verbose')
                    console.log(`  ${payload.where.split("'")[1]}  SELECTing file from database`);
            }
            else if (payload.type === 'INSERT') {
                console.log(`  ${payload.instance.dataValues.hash}  INSERTing file to database`);
            }
            else if (payload.type === 'UPDATE') {
                if (payload.fields !== undefined)
                    console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Changing columns: ${payload.fields.join(', ')}`);
                else if (payload.increment)
                    console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Incrementing Value`);
                else {
                    console.error('Unknown database action');
                    console.log(payload);
                }
            }
        }
    });
    const UncachedFileModel = sequelize.define('File', {
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
    }, {
        tableName: 'file',
        timestamps: true,
        modelName: 'FileHandler'
    });
    const cache = new SequelizeSimpleCache({ File: { ttl: 30 * 60 } });
    try {
        yield sequelize.sync({ alter: true });
    }
    catch (e) {
        const err = e;
        if (err.original.message.includes('file_backup')) {
            yield sequelize.query('DROP TABLE IF EXISTS file_backup');
            yield sequelize.sync({ alter: true });
        }
        else
            throw e;
    }
    console.log('Connected to the database');
    return cache.init(UncachedFileModel);
});
export default startDatabase;
