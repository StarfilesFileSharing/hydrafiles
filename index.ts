import http, { IncomingMessage, ServerResponse }from 'http';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';

const __dirname = path.resolve();

// CONFIG /////////////////////////////////////
let HOSTNAME = '127.0.0.1';
let PORT = 3000;
let MAX_STORAGE = 100 * 1024 * 1024 * 1024; // 100GB
let PERMA_FILES = []; // File hashes to never delete when storage limit is reached
let BURN_RATE = 0.1; // Percentage of files to purge when storage limit is reached
// CONFIG /////////////////////////////////////


// ADVANCED CONFIG ////////////////////////////
let PUBLIC_HOSTNAME = HOSTNAME + (PORT !== 80 && PORT !== 443 ? `:${PORT}` : ''); // The hostname that will be used to announce to other nodes
let METADATA_ENDPOINT = 'https://api2.starfiles.co/file/';
let BOOTSTRAP_NODES = [
	{"host": "hydrafiles.com", "http": true, "dns": false, "cf": false},
	{"host": "starfilesdl.com", "http": true, "dns": false, "cf": false},
	{"host": "hydra.starfiles.co", "http": true, "dns": false, "cf": false},
];
let NODES_PATH = path.join(__dirname, 'nodes.json');
// ADVANCED CONFIG ////////////////////////////



// TYPES //////////////////////////////////////
type Metadata = {name: string, size: string, type: string, hash: string, id: string};
type ResponseHeaders = { [key: string]: string };
type File = { file: Buffer, name?: string } | false;
type Node = {
	host: string,
	http: boolean,
	dns: boolean,
	cf: boolean,
	// File download success/fail count
	hits: number,
	rejects: number,
};
// TYPES //////////////////////////////////////



// INITIALISATION /////////////////////////////
if(!fs.existsSync(path.join(__dirname, 'files'))) fs.mkdirSync(path.join(__dirname, 'files'));
if(!fs.existsSync(path.join(__dirname, 'nodes.json'))) fs.writeFileSync(path.join(__dirname, 'nodes.json'), JSON.stringify(BOOTSTRAP_NODES));
// INITIALISATION /////////////////////////////


// For automated deployments
if(fs.existsSync(path.join(__dirname, 'config.json'))){
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')).toString());
    if(config.port) PORT = config.port;
    if(config.hostname) HOSTNAME = config.hostname;
    if(config.max_storage) MAX_STORAGE = config.max_storage;
    if(config.perma_files) PERMA_FILES = config.perma_files;
    if(config.burn_rate) BURN_RATE = config.burn_rate;
    if(config.metadata_endpoint) METADATA_ENDPOINT = config.metadata_endpoint;
    if(config.bootstrap_nodes) BOOTSTRAP_NODES = config.bootstrap_nodes;
	if(config.nodes_path) NODES_PATH = config.nodes_path;
	if(config.public_hostname) PUBLIC_HOSTNAME = config.public_hostname;
}

const isIp = (host: string) => host.match(/(?:\d+\.){3}\d+(?::\d+)?/) !== null;

function isPrivateIP(ip: string) {
	ip = ip.split(':')[0];
   	var parts = ip.split('.');
   	return parts[0] === '10' || 
      	(parts[0] === '172' && (parseInt(parts[1], 10) >= 16 && parseInt(parts[1], 10) <= 31)) || 
      	(parts[0] === '192' && parts[1] === '168') ||
	  	(parts[0] === '127');
}

let usedStorage = 0;
const download_count: { [key: string]: number;} = {};

const purgeCache = (requiredSpace: number, remainingSpace: number) => {
	const files = fs.readdirSync(path.join(__dirname, 'files'));
	for(const file of files){
		if(PERMA_FILES.includes(file) || Object.keys(download_count).includes(file)) continue;

		const size = fs.statSync(path.join(__dirname, 'files', file)).size;
		fs.unlinkSync(path.join(__dirname, 'files', file));
		usedStorage -= size;
		remainingSpace += size;

		if (requiredSpace <= remainingSpace) break;
	}
	if(requiredSpace > remainingSpace){
		const sorted = Object.entries(download_count).sort(([,a],[,b]) => Number(a) - Number(b)).filter(([file]) =>!PERMA_FILES.includes(file))
		for(let i = 0; i < sorted.length / (BURN_RATE*100); i++) {
			const stats = fs.statSync(path.join(__dirname, 'files', sorted[i][0]));
			fs.unlinkSync(path.join(__dirname, 'files', sorted[i][0]));
			usedStorage -= stats.size;
		}
	}
};

const cacheFile = (filePath: string, file: Buffer) => {
	const size = file.length;
	let remainingSpace = MAX_STORAGE - usedStorage;
	if(size > remainingSpace) purgeCache(size, remainingSpace);
	fs.writeFileSync(filePath, file);
	usedStorage += size;
};

const getNodes = (includeSelf = true): Node[] => {
	return JSON.parse(fs.readFileSync(NODES_PATH).toString()).sort(() => Math.random() - 0.5).filter((node: { host: string; }) => includeSelf || node.host !== PUBLIC_HOSTNAME);
};

const downloadFromNode = async (host: string, fileHash: string, fileId: string): Promise<File> => {
	try{
		const response = await fetch(`${isIp(host) ? 'http' : 'https'}://${host}/download/${fileHash + (fileId ? `/${fileId}` : '')}`);
		const arrayBuffer = await response.arrayBuffer();
		const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

		const name = response.headers.get('Content-Disposition')?.split('=')[1].replace(/"/g, '');

		if(hash !== fileHash) return false;
		else return { file: Buffer.from(arrayBuffer), name };
	}catch(e){
		return false;
	}
}

const fetchFile = (filehash: string): File => {
	const filePath = path.join(__dirname, 'files', filehash);
	if(fs.existsSync(filePath)){
		return { file: fs.readFileSync(filePath) };
	}else{
		return false;
	}
};

const updateNode = (node: Node) => {
	const nodes = getNodes();
	const index = nodes.findIndex((n: { host: string; }) => n.host === node.host);
	nodes[index] = node;
	fs.writeFileSync(NODES_PATH, JSON.stringify(nodes));
};

const getFile = async (fileHash: string, fileId: string): Promise<File> => {
	const filePath = path.join(__dirname, 'files', fileHash);

	const localFile = fetchFile(fileHash);
	if(localFile){
		return localFile;
	}

	for(const node of getNodes(false)){
		if(node.http){
			const file = await downloadFromNode(node.host, fileHash, fileId);
			if(file){
				node.hits++;
				updateNode(node);
				cacheFile(filePath, file.file);
				return file;
			}else{
				node.rejects++;
				updateNode(node);
			}
		}
	}

	return false;
};

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
	console.log('  ', req.url)

	if (req.url === '/'){
		res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=604800' });
		fs.createReadStream('index.html').pipe(res);

	}else if(req.url === '/nodes'){
		res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600'});
		fs.createReadStream(NODES_PATH).pipe(res);

	}else if(req.url?.startsWith('/announce')){
		const params = Object.fromEntries(new URLSearchParams(req.url.split('?')[1]));
		const host = params['host'];
		if(!host) return res.end('Invalid request\n');

		const nodes = getNodes();
		if(nodes.find((node) => node.host === host)) return res.end('Already known\n');

		if(await downloadFromNode(host, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f', 'c8fcb43d6e46')){
			nodes.push({host, http: true, dns: false, cf: false, hits: 0, rejects: 0 });
			fs.writeFileSync(NODES_PATH, JSON.stringify(nodes));
			res.end('Announced\n');
		}else res.end('Invalid request\n');

	}else if(req.url?.startsWith('/download/')){
		const fileHash = req.url.split('/')[2];
		const fileId = req.url.split('/')[3];

		const headers: ResponseHeaders = {
			'Content-Type': 'application/octet-stream',
			'Cache-Control': 'public, max-age=31536000',
		}

		const file = await getFile(fileHash, fileId);

		if(!file){
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('404 Not Found\n');
			return;
		}

		let name: string = "";
		if(fileId){
			const response = await fetch(`${METADATA_ENDPOINT}${fileId}`);
			if(response.status === 200) name = (await response.json() as Metadata).name;
		}

		name = name || file.name || "File";
		headers['Content-Length'] = file.file.length.toString();
		headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(name).replace(/%20/g, ' ')}"`;

		res.writeHead(200, headers);
		res.end(file.file);
		download_count[fileHash] = download_count[fileHash] ? download_count[fileHash] + 1 : 1;

	}else{
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('404 Not Found\n');
	}
	return;
});

server.listen(PORT, HOSTNAME, async () => {
	console.log(`Server running at http://${PUBLIC_HOSTNAME}/`);

	const filesPath = path.join(__dirname, 'files');
	if(fs.existsSync(filesPath)){
		const files = fs.readdirSync(filesPath);
		for(const file of files){
			const stats = fs.statSync(path.join(filesPath, file));
			usedStorage += stats.size;
		}
	}
	console.log(`Files dir size: ${usedStorage} bytes`);

	// Call all nodes and pull their /nodes
	const nodes = getNodes(false);
	for(const node of nodes){
		try{
			if(node.http){
				const response = await fetch(`${isIp(node.host) ? 'http' : 'https'}://${node.host}/nodes`);
				if(response.status === 200){
					const remoteNodes = await response.json() as Node[];
					for(const remoteNode of remoteNodes){
						if(!nodes.find((node: { host: string; }) => node.host === remoteNode.host) && await downloadFromNode(remoteNode.host, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f', 'c8fcb43d6e46')) nodes.push(remoteNode);
					}
				}
			}
		}catch(e){
			console.error('Failed to fetch nodes from', node.host);
		}
	}
	fs.writeFileSync(NODES_PATH, JSON.stringify(nodes));

	await downloadFromNode(`${HOSTNAME + (PORT != 80 ? `:${PORT}` : '')}`, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f', 'c8fcb43d6e46');
	if(!fs.existsSync(path.join(__dirname, 'files', '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f')))
		console.error('Download test failed, cannot connect to network');
	else if(isIp(PUBLIC_HOSTNAME) && isPrivateIP(PUBLIC_HOSTNAME))
		console.error('Public hostname is a private IP address, cannot announce to other nodes');
	else{
		console.log(await downloadFromNode(`${PUBLIC_HOSTNAME}`, '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f', 'c8fcb43d6e46'));

		// Save self to nodes.json
		if(!nodes.find((node: { host: string; }) => node.host === PUBLIC_HOSTNAME)){
			nodes.push({host: PUBLIC_HOSTNAME, http: true, dns: false, cf: false, hits: 0, rejects: 0 });
			fs.writeFileSync(NODES_PATH, JSON.stringify(nodes));
		}

		console.log('Announcing to nodes');
		for(const node of nodes){
			if(node.http){
				if(node.host === PUBLIC_HOSTNAME) continue;
				console.log('Announcing to', node.host)
				await fetch(`${isIp(node.host) ? 'http' : 'https'}://${node.host}/announce?host=${PUBLIC_HOSTNAME}`);
			}
		}
	}
});
