import untypedDefaultConfig from "../config.default.json" with {
	type: "json",
};

const defaultConfig = untypedDefaultConfig as unknown as Config;

export interface Config {
	port: number;
	hostname: string;
	maxCache: number;
	permaFiles: string[];
	burnRate: number;
	metadataEndpoint: string;
	bootstrapNodes: string[];
	publicHostname: string;
	preferNode: "FASTEST" | "LEAST_USED" | "RANDOM" | "HIGHEST_HITRATE";
	uploadSecret: string;
	memoryThreshold: number;
	memoryThresholdReachedWait: number;
	timeout: number;
	logLevel: "verbose" | "normal";
	summarySpeed: number;
	compareSpeed: number;
	backfill: boolean;
	compareNodes: boolean;
	compareFiles: boolean;
	s3AccessKeyId: string;
	s3SecretAccessKey: string;
	s3Endpoint: string;
	cacheS3: boolean;
	databaseLogs: boolean;
}

const getConfig = (config: Partial<Config> = {}): Config => {
	return {
		port: config?.port ?? defaultConfig.port,
		hostname: config?.hostname ?? defaultConfig.hostname,
		maxCache: config?.maxCache ?? defaultConfig.maxCache,
		permaFiles: config?.permaFiles ?? defaultConfig.permaFiles,
		burnRate: config?.burnRate ?? defaultConfig.burnRate,
		metadataEndpoint: config?.metadataEndpoint ?? defaultConfig.metadataEndpoint,
		bootstrapNodes: config?.bootstrapNodes ?? defaultConfig.bootstrapNodes,
		publicHostname: config?.publicHostname ?? defaultConfig.publicHostname,
		preferNode: config?.preferNode ?? defaultConfig.preferNode,
		uploadSecret: config?.uploadSecret ?? defaultConfig.uploadSecret,
		memoryThreshold: config?.memoryThreshold ?? defaultConfig.memoryThreshold,
		memoryThresholdReachedWait: config?.memoryThresholdReachedWait ?? defaultConfig.memoryThresholdReachedWait,
		timeout: config?.timeout ?? defaultConfig.timeout,
		logLevel: config?.logLevel ?? defaultConfig.logLevel,
		summarySpeed: config?.summarySpeed ?? defaultConfig.summarySpeed,
		compareSpeed: config?.compareSpeed ?? defaultConfig.compareSpeed,
		backfill: config?.backfill ?? defaultConfig.backfill,
		compareNodes: config?.compareNodes ?? defaultConfig.compareNodes,
		compareFiles: config?.compareFiles ?? defaultConfig.compareFiles,
		s3AccessKeyId: config?.s3AccessKeyId ?? defaultConfig.s3AccessKeyId,
		s3SecretAccessKey: config?.s3SecretAccessKey ?? defaultConfig.s3SecretAccessKey,
		s3Endpoint: config?.s3Endpoint ?? defaultConfig.s3Endpoint,
		cacheS3: config?.cacheS3 ?? defaultConfig.cacheS3,
		databaseLogs: config?.databaseLogs ?? defaultConfig.databaseLogs,
	};
};

export default getConfig;
