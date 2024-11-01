export interface Config {
	/* HTTP Server */
	port: number; // HTTP listen port
	hostname: string; // HTTP listen hostname
	publicHostname: string; // Root URL (`https://hostname[:port]`) to announce to other nodes

	/* Intervals (in MS) (-1 = Off) */
	summarySpeed: number; // How often to log client state
	announceSpeed: number; // How often to re-announce to WebSocket
	compareFilesSpeed: number; // How often to compare file lists with others
	comparePeersSpeed: number; // How often to fetch peers from others

	/* Storage */
	maxCache: number; // Max cache size in bytes, will purge cache when reached (0 = No Cache, -1 = Unlimited)
	permaFiles: string[]; // Files to keep during cache purge
	burnRate: number; // If `max_cache` isn't -1: Percentage of cache to clear when `max_cache` reached (0 = 0% deleted, 0.5 = 50% deleted, 1 = 100% deleted) (Files will still be deleted even with this option set to 0, this config deletes additional space to make cache purges less frequent)
	backfill: boolean; // Whether or not you'd like to donate spare storage to improve anonimity (up to `max_cache`)

	/* Memory */
	memoryThreshold: number; // When expected RAM usage + `memory_threshold` is greater than free memory, pause tasks
	memoryThresholdReachedWait: number; // How frequently to recheck memory usage if tasks are paused in MS

	/* Peers */
	bootstrapPeers: string[]; // Root URL (`https://hostname:port`) of nodes to bootstrap network connection off
	preferNode: "FASTEST" | "LEAST_USED" | "RANDOM" | "HIGHEST_HITRATE"; // Order to check nodes when fetching data from the network
	timeout: number; // How long to wait before timing out a connection with a peer in MS

	/* S3 (Compatible) Buckets */
	cacheS3: boolean; // Whether or not S3 files should be cached
	s3AccessKeyId: string;
	s3SecretAccessKey: string;
	s3Endpoint: string;

	/* Other */
	logLevel: "verbose" | "normal"; // Set to verbose if you need better error reporting
	uploadSecret: string; // Place random string to authenticate HTTP uploads
	reverseProxy: string; //  See https://github.com/StarfilesFileSharing/hydrafiles/wiki/Using-Hydrafiles-as-Reverse-Proxy-%E2%80%90-Anonymous-APIs
	dontUseFileSystemAPI: boolean; // Avoid using filesystem api in browser which requires user consent
}

const defaultConfig: Config = {
	"hostname": "0.0.0.0",
	"port": 80,
	"publicHostname": "http://127.0.0.1:80",
	"maxCache": -1,
	"permaFiles": ["04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f"],
	"preferNode": "HIGHEST_HITRATE",
	"bootstrapPeers": ["https://hydrafiles.com", "https://hydra.starfiles.co", "https://api2.starfiles.co", "https://api2.starfiles.bz"],
	"burnRate": 0.1,
	"s3AccessKeyId": "",
	"s3SecretAccessKey": "",
	"s3Endpoint": "",
	"cacheS3": true,
	"memoryThreshold": 0,
	"memoryThresholdReachedWait": 100,
	"timeout": 60000,
	"uploadSecret": "",
	"logLevel": "normal",
	"summarySpeed": -1,
	"backfill": true,
	"comparePeersSpeed": 3600000,
	"compareFilesSpeed": 300000,
	"announceSpeed": 30000,
	"reverseProxy": "",
	"dontUseFileSystemAPI": false,
};

const getConfig = (config: Partial<Config> = {}): Config => ({ ...defaultConfig, ...config });

export default getConfig;
