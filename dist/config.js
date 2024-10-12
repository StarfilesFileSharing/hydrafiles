import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const defaultConfig = JSON.parse(fs.readFileSync(path.join(DIRNAME, '../config.default.json')).toString());
const getConfig = (config) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z;
    return {
        port: (_a = config === null || config === void 0 ? void 0 : config.port) !== null && _a !== void 0 ? _a : defaultConfig.port,
        hostname: (_b = config === null || config === void 0 ? void 0 : config.hostname) !== null && _b !== void 0 ? _b : defaultConfig.hostname,
        max_cache: (_c = config === null || config === void 0 ? void 0 : config.max_cache) !== null && _c !== void 0 ? _c : defaultConfig.max_cache,
        perma_files: (_d = config === null || config === void 0 ? void 0 : config.perma_files) !== null && _d !== void 0 ? _d : defaultConfig.perma_files,
        burn_rate: (_e = config === null || config === void 0 ? void 0 : config.burn_rate) !== null && _e !== void 0 ? _e : defaultConfig.burn_rate,
        metadata_endpoint: (_f = config === null || config === void 0 ? void 0 : config.metadata_endpoint) !== null && _f !== void 0 ? _f : defaultConfig.metadata_endpoint,
        bootstrap_nodes: (_g = config === null || config === void 0 ? void 0 : config.bootstrap_nodes) !== null && _g !== void 0 ? _g : defaultConfig.bootstrap_nodes,
        public_hostname: (_h = config === null || config === void 0 ? void 0 : config.public_hostname) !== null && _h !== void 0 ? _h : defaultConfig.public_hostname,
        prefer_node: (_j = config === null || config === void 0 ? void 0 : config.prefer_node) !== null && _j !== void 0 ? _j : defaultConfig.prefer_node,
        max_concurrent_nodes: (_k = config === null || config === void 0 ? void 0 : config.max_concurrent_nodes) !== null && _k !== void 0 ? _k : defaultConfig.max_concurrent_nodes,
        upload_secret: (_l = config === null || config === void 0 ? void 0 : config.upload_secret) !== null && _l !== void 0 ? _l : defaultConfig.upload_secret,
        memory_threshold: (_m = config === null || config === void 0 ? void 0 : config.memory_threshold) !== null && _m !== void 0 ? _m : defaultConfig.memory_threshold,
        memory_threshold_reached_wait: (_o = config === null || config === void 0 ? void 0 : config.memory_threshold_reached_wait) !== null && _o !== void 0 ? _o : defaultConfig.memory_threshold_reached_wait,
        timeout: (_p = config === null || config === void 0 ? void 0 : config.timeout) !== null && _p !== void 0 ? _p : defaultConfig.timeout,
        log_level: (_q = config === null || config === void 0 ? void 0 : config.log_level) !== null && _q !== void 0 ? _q : defaultConfig.log_level,
        summary_speed: (_r = config === null || config === void 0 ? void 0 : config.summary_speed) !== null && _r !== void 0 ? _r : defaultConfig.summary_speed,
        compare_speed: (_s = config === null || config === void 0 ? void 0 : config.compare_speed) !== null && _s !== void 0 ? _s : defaultConfig.compare_speed,
        backfill: (_t = config === null || config === void 0 ? void 0 : config.backfill) !== null && _t !== void 0 ? _t : defaultConfig.backfill,
        compare_nodes: (_u = config === null || config === void 0 ? void 0 : config.compare_nodes) !== null && _u !== void 0 ? _u : defaultConfig.compare_nodes,
        compare_files: (_v = config === null || config === void 0 ? void 0 : config.compare_files) !== null && _v !== void 0 ? _v : defaultConfig.compare_files,
        s3_access_key_id: (_w = config === null || config === void 0 ? void 0 : config.s3_access_key_id) !== null && _w !== void 0 ? _w : defaultConfig.s3_access_key_id,
        s3_secret_access_key: (_x = config === null || config === void 0 ? void 0 : config.s3_secret_access_key) !== null && _x !== void 0 ? _x : defaultConfig.s3_secret_access_key,
        s3_endpoint: (_y = config === null || config === void 0 ? void 0 : config.s3_endpoint) !== null && _y !== void 0 ? _y : defaultConfig.s3_endpoint,
        cache_s3: (_z = config === null || config === void 0 ? void 0 : config.cache_s3) !== null && _z !== void 0 ? _z : defaultConfig.cache_s3
    };
};
export default getConfig;
