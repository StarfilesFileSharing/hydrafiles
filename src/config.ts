import untypedDefaultConfig from "../config.default.json" with {
	type: "json",
};

const defaultConfig = untypedDefaultConfig as unknown as Config;

export interface Config {
	port: number; // HTTP listen port
	hostname: string; // HTTP listen hostname
	maxCache: number; // Max cache size in bytes, will purge cache when reached (0 = No Cache, -1 = Unlimited)
	permaFiles: string[]; // Files to keep during cache purge
	burnRate: number; // If `max_cache` isn't -1: Percentage of cache to clear when `max_cache` reached (0 = 0% deleted, 0.5 = 50% deleted, 1 = 100% deleted) (Files will still be deleted even with this option set to 0, this config deletes additional space to make cache purges less frequent)
	bootstrapNodes: string[]; // Root URL (`https://hostname:port`) of nodes to bootstrap network connection off
	publicHostname: string; // Root URL (`https://hostname:port`) to announce to other nodes
	preferNode: "FASTEST" | "LEAST_USED" | "RANDOM" | "HIGHEST_HITRATE"; // Order to check nodes when fetching data from the network
	uploadSecret: string; // Place random string to authenticate HTTP uploads
	memoryThreshold: number; // When expected RAM usage + `memory_threshold` is greater than free memory, pause tasks
	memoryThresholdReachedWait: number; // How frequently to recheck memory usage if tasks are paused in MS
	timeout: number; // How long to wait before timing out a connection with a node in MS
	logLevel: "verbose" | "normal"; // Set to verbose if you need better error reporting
	summarySpeed: number; // How often to log client state in MS (-1 = Off)
	backfill: boolean; // Whether or not you'd like to donate spare storage (up to `max_cache`)
	comparePeersSpeed: number; // How often to fetch peers from others in MS (DO NOT TURN OFF)
	compareFilesSpeed: number; // How often to compare file lists with others in MS
	databaseLogs: boolean; // Whether or not to log successful queries
	reverseProxy: string; //  See https://github.com/StarfilesFileSharing/hydrafiles/wiki/Using-Hydrafiles-as-Reverse-Proxy-%E2%80%90-Anonymous-APIs
	cacheS3: boolean; // Whether or not S3 files should be cached
	s3AccessKeyId: string;
	s3SecretAccessKey: string;
	s3Endpoint: string;
}

const getConfig = (config: Partial<Config> = {}): Config => {
	return {
		port: config?.port ?? defaultConfig.port,
		hostname: config?.hostname ?? defaultConfig.hostname,
		maxCache: config?.maxCache ?? defaultConfig.maxCache,
		permaFiles: config?.permaFiles ?? defaultConfig.permaFiles,
		burnRate: config?.burnRate ?? defaultConfig.burnRate,
		bootstrapNodes: config?.bootstrapNodes ?? defaultConfig.bootstrapNodes,
		publicHostname: config?.publicHostname ?? defaultConfig.publicHostname,
		preferNode: config?.preferNode ?? defaultConfig.preferNode,
		uploadSecret: config?.uploadSecret ?? defaultConfig.uploadSecret,
		memoryThreshold: config?.memoryThreshold ?? defaultConfig.memoryThreshold,
		memoryThresholdReachedWait: config?.memoryThresholdReachedWait ?? defaultConfig.memoryThresholdReachedWait,
		timeout: config?.timeout ?? defaultConfig.timeout,
		logLevel: config?.logLevel ?? defaultConfig.logLevel,
		summarySpeed: config?.summarySpeed ?? defaultConfig.summarySpeed,
		backfill: config?.backfill ?? defaultConfig.backfill,
		comparePeersSpeed: config?.comparePeersSpeed ?? defaultConfig.comparePeersSpeed,
		compareFilesSpeed: config?.compareFilesSpeed ?? defaultConfig.compareFilesSpeed,
		s3AccessKeyId: config?.s3AccessKeyId ?? defaultConfig.s3AccessKeyId,
		s3SecretAccessKey: config?.s3SecretAccessKey ?? defaultConfig.s3SecretAccessKey,
		s3Endpoint: config?.s3Endpoint ?? defaultConfig.s3Endpoint,
		cacheS3: config?.cacheS3 ?? defaultConfig.cacheS3,
		databaseLogs: config?.databaseLogs ?? defaultConfig.databaseLogs,
		reverseProxy: config?.reverseProxy ?? defaultConfig.reverseProxy,
	};
};

export default getConfig;
