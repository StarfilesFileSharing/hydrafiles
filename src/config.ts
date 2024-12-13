import type { Host } from "./rpc/RPCPeer.ts";

/**
 * Configuration
 *
 *  - If running via startup file, custom config can be set at `./config.json` in the project.
 *  - If running via compiled binary, config can be piped like this: `./hydrafiles ./config.json`.
 *  - If using as library, config can be piped like this: `new Hydrafiles(config)`.
 */
export interface Config {
	/**
	 * HTTP listen port.
	 * @default 80
	 */
	httpPort: number;

	/**
	 * HTTPS listen port.
	 * @default 443
	 */
	httpsPort: number;

	/**
	 * SSL Certificate Path.
	 * @default "./certs/ca/localhost/localhost.crt"
	 */
	sslCertPath: string;

	/**
	 * SSL Key Path.
	 * @default "./certs/ca/localhost/localhost.key"
	 */
	sslKeyPath: string;

	/**
	 * HTTP listen hostname.
	 * @default "0.0.0.0"
	 */
	hostname: string;

	/**
	 * Root URL (`https://hostname[:port]`) to announce to other nodes.
	 * @default "http://127.0.0.1:80"
	 */
	publicHostname: Host;

	/**
	 * How often to log client state (in milliseconds).
	 * -1 to disable.
	 * @default 30000
	 */
	summarySpeed: number;

	/**
	 * How often to re-announce to WebSocket (in milliseconds).
	 * @default 30000
	 */
	announceSpeed: number;

	/**
	 * How often to compare file lists with others (in milliseconds).
	 * @default 30000
	 */
	compareFilesSpeed: number;

	/**
	 * How often to fetch peers from others (in milliseconds).
	 * @default 3600000
	 */
	comparePeersSpeed: number;

	/**
	 * Max cache size in bytes; will purge cache when reached.
	 * 0 for no cache, -1 for unlimited.
	 * @default -1
	 */
	maxCache: number;

	/**
	 * Files to keep during cache purge.
	 * @default ["04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f"]
	 */
	permaFiles: string[];

	/**
	 * If `maxCache` isn't -1, percentage of cache to clear when `maxCache` is reached.
	 * Range: 0 to 1, where 0.1 means 10%.
	 * @default 0.1
	 */
	burnRate: number;

	/**
	 * Donate spare storage to improve anonymity (up to `maxCache`).
	 * @default true
	 */
	backfill: boolean;

	/**
	 * Pause tasks if expected RAM usage + `memoryThreshold` exceeds free memory.
	 * @default 0
	 */
	memoryThreshold: number;

	/**
	 * Recheck memory usage if tasks are paused (in milliseconds).
	 * @default 100
	 */
	memoryThresholdReachedWait: number;

	/**
	 * Root URLs of peers to bootstrap network connection.
	 * @default ["https://hydrafiles.com", "https://hydra.starfiles.co", "https://api2.starfiles.co", "https://api2.starfiles.bz", "https://hydra.sts.st"]
	 */
	bootstrapPeers: Host[];

	/**
	 * Root URLs of peers to bootstrap network connection.
	 * @default []
	 */
	customPeers: Host[];

	/**
	 * Node selection strategy when fetching data from the network.
	 * @default "HIGHEST_HITRATE"
	 */
	preferNode: "FASTEST" | "LEAST_USED" | "RANDOM" | "HIGHEST_HITRATE";

	/**
	 * Timeout for peer connections (in milliseconds).
	 * @default 60000
	 */
	timeout: number;

	/**
	 * Cache S3-compatible files.
	 * @default true
	 */
	cacheS3: boolean;

	/**
	 * S3 access key ID.
	 * @default ""
	 */
	s3AccessKeyId: string;

	/**
	 * S3 secret access key.
	 * @default ""
	 */
	s3SecretAccessKey: string;

	/**
	 * S3 endpoint.
	 * @default ""
	 */
	s3Endpoint: string;

	/**
	 * Logging verbosity.
	 * @default "normal"
	 */
	logLevel: "verbose" | "normal";

	/**
	 * Secret for authenticating HTTP uploads.
	 * @default ""
	 */
	uploadSecret: string;

	/**
	 * Avoid filesystem API in browser to prevent user consent requirement.
	 * @default false
	 */
	dontUseFileSystemAPI: boolean;

	/**
	 * SHA256 string to derive private key from.
	 * @default ""
	 */
	deriveKey: string;

	/**
	 * Whether or not to listen for & serve requests via HTTP, WebRTC, WS. Disabling this breaks many P2P functionalities such as lowing data availability and lowering privacy. Static files (i.e. GUI and docs) are still served.
	 * @default true
	 */
	listen: boolean;

	/**
	 * How long to cache WebSocket messages for.
	 * @default 60000
	 */
	wsMessageCacheTime: number;
}

// DO NOT CHANGE DEFAULT CONFIG - Check documentation on how to set custom config.
const defaultConfig: Config = {
	hostname: "0.0.0.0",
	httpPort: 80,
	httpsPort: 443,
	sslCertPath: "./certs/ca/localhost/localhost.crt",
	sslKeyPath: "./certs/ca/localhost/localhost.key",
	publicHostname: "http://127.0.0.1:80",
	maxCache: -1,
	permaFiles: ["04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f"],
	preferNode: "HIGHEST_HITRATE",
	bootstrapPeers: ["https://hydrafiles.com", "https://hydra.starfiles.co", "https://api2.starfiles.co", "https://api2.starfiles.bz", "https://hydra.sts.st"],
	customPeers: [],
	burnRate: 0.1,
	s3AccessKeyId: "",
	s3SecretAccessKey: "",
	s3Endpoint: "",
	cacheS3: true,
	memoryThreshold: 0,
	memoryThresholdReachedWait: 100,
	timeout: 60000,
	uploadSecret: "",
	logLevel: "normal",
	summarySpeed: 300000,
	backfill: true,
	comparePeersSpeed: 300000,
	compareFilesSpeed: 600000,
	announceSpeed: 60000,
	dontUseFileSystemAPI: false,
	deriveKey: "",
	listen: true,
	wsMessageCacheTime: 60000,
};

/** @internal */
const getConfig = (config: Partial<Config> = {}): Config => ({ ...defaultConfig, ...config });

export default getConfig;
