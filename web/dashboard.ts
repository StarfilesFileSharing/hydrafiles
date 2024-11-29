import { EthAddress } from "./../src/wallet.ts";
import Hydrafiles from "../src/hydrafiles.ts";
import { type FileAttributes } from "../src/file.ts";
import WebTorrent from "https://esm.sh/webtorrent@2.5.1";
import { Chart } from "https://esm.sh/chart.js@4.4.6/auto";
import { ErrorNotInitialised } from "../src/errors.ts";
import { decodeBase32, encodeBase32 } from "https://deno.land/std@0.224.0/encoding/base32.ts";
import { DataSet } from "npm:vis-data/esnext";
import { Network } from "npm:vis-network/esnext";
import Utils from "../src/utils.ts";
import { Edge, Node } from "npm:vis-network/esnext";
import type { FileEvent, RTCEvent } from "../src/events.ts";

declare global {
	interface Window {
		hydrafiles: Hydrafiles;
	}
}

interface HSVColor {
	h: number; // Hue [0, 1]
	s: number; // Saturation [0, 1]
	v: number; // Value [0, 1]
}

interface RGBColor {
	r: number; // Red [0, 255]
	g: number; // Green [0, 255]
	b: number; // Blue [0, 255]
}

class ColorGenerator {
	private readonly GOLDEN_RATIO = 0.618033988749895;
	private currentHue = 0.1; // Start with a vibrant base hue

	/**
	 * Converts HSV color values to RGB
	 * Uses advanced color space transformation algorithms
	 */
	private hsvToRgb({ h, s, v }: HSVColor): RGBColor {
		const i = Math.floor(h * 6);
		const f = h * 6 - i;
		const p = v * (1 - s);
		const q = v * (1 - f * s);
		const t = v * (1 - (1 - f) * s);

		let r: number, g: number, b: number;

		switch (i % 6) {
			case 0:
				[r, g, b] = [v, t, p];
				break;
			case 1:
				[r, g, b] = [q, v, p];
				break;
			case 2:
				[r, g, b] = [p, v, t];
				break;
			case 3:
				[r, g, b] = [p, q, v];
				break;
			case 4:
				[r, g, b] = [t, p, v];
				break;
			default: // case 5
				[r, g, b] = [v, p, q];
				break;
		}

		return {
			r: Math.round(r * 255),
			g: Math.round(g * 255),
			b: Math.round(b * 255),
		};
	}

	/**
	 * Converts RGB values to hexadecimal color code
	 */
	private rgbToHex({ r, g, b }: RGBColor): string {
		const toHex = (n: number): string => {
			const hex = n.toString(16);
			return hex.length === 1 ? "0" + hex : hex;
		};

		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	/**
	 * Generates an array of visually distinct colors
	 * @param count Number of colors to generate
	 * @param options Optional parameters for customization
	 * @returns Array of hex color codes
	 */
	public generateColors(
		count: number,
		options: {
			saturation?: number; // Default: 0.85
			value?: number; // Default: 0.95
			startHue?: number; // Default: 0.1
		} = {},
	): string[] {
		const {
			saturation = 0.85,
			value = .95,
			startHue = this.currentHue,
		} = options;

		const colors: string[] = [];
		let hue = startHue;

		for (let i = 0; i < count; i++) {
			const hsv: HSVColor = { h: hue, s: saturation, v: value };
			const rgb = this.hsvToRgb(hsv);
			colors.push(this.rgbToHex(rgb));

			// Advance to next hue using golden ratio for optimal spacing
			hue = (hue + this.GOLDEN_RATIO) % 1.0;
		}

		this.currentHue = hue; // Save the last hue for potential subsequent calls
		return colors;
	}
}

function formatTSCode(code: string): string {
	const indent = (lines: string[], level: number) => lines.map((line) => "  ".repeat(level) + line);
	let formatted = "", depth = 0, inString = false, escape = false;
	for (let i = 0; i < code.length; i++) {
		const char = code[i];
		if (inString) {
			if (char === "\\" && !escape) escape = true;
			else if ((char === "'" || char === '"' || char === "`") && !escape) inString = false;
			else escape = false;
			formatted += char;
		} else {
			if (char === "'" || char === '"' || char === "`") inString = true;
			if (char === "{" || char === "[" || char === "(") {
				formatted += char + "\n";
				formatted += indent([""], ++depth).join("");
			} else if (char === "}" || char === "]" || char === ")") {
				formatted += "\n";
				formatted += indent([""], --depth).join("") + char;
			} else if (char === ";") {
				formatted += char + "\n" + indent([""], depth).join("");
			} else if (char === "\n" || char === "\r") {
				continue;
			} else {
				formatted += char;
			}
		}
	}
	return formatted.split("\n").map((line) => line.trimEnd()).join("\n");
}

function loadSavedCredentials(): { email: string; password: string } | null {
	const savedCredentials = localStorage.getItem("hydrafilesCredentials");
	if (savedCredentials) return JSON.parse(savedCredentials);
	return null;
}

const convertTime = (duration: number): string => {
	const msPerSecond = 1000;
	const msPerMinute = msPerSecond * 60;
	const msPerHour = msPerMinute * 60;
	const msPerDay = msPerHour * 24;

	if (duration < msPerMinute) return (duration / msPerSecond).toFixed(2) + "s";
	else if (duration < msPerHour) return (duration / msPerMinute).toFixed(2) + "m";
	else if (duration < msPerDay) return (duration / msPerHour).toFixed(2) + "h";
	else return (duration / msPerDay).toFixed(2) + " days";
};

document.getElementById("startHydrafilesButton")!.addEventListener("click", async () => {
	(document.getElementById("startHydrafiles") as HTMLElement).style.display = "none";
	(document.getElementById("main") as HTMLElement).classList.remove("hidden");

	const email = (document.getElementById("email") as HTMLInputElement).value;
	const password = (document.getElementById("password") as HTMLInputElement).value;

	if (!email || !password) {
		alert("No email or password provided");
		window.location.reload();
		return;
	}

	const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (!emailPattern.test(email)) {
		alert("Invalid email format");
		window.location.reload();
		return;
	}

	const rememberMe = (document.getElementById("rememberMe") as HTMLInputElement).checked;
	if (rememberMe) localStorage.setItem("hydrafilesCredentials", JSON.stringify({ email, password }));
	else localStorage.removeItem("hydrafilesCredentials");

	const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${email}:${password}`));
	const deriveKey = Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

	window.hydrafiles = new Hydrafiles({ deriveKey, customPeers: [`${window.location.protocol}//${window.location.hostname}`], baseDir: "dashboard/" });
	const webtorrent = new WebTorrent();

	await window.hydrafiles.start({ onUpdateFileListProgress, webtorrent });
	console.log("Hydrafiles web node is running", window.hydrafiles);
	setInterval(tickHandler, 30 * 1000);
	tickHandler();

	const seenMessages = new Set<string>();
	const messageBox = document.getElementById("messages") as HTMLElement;
	document.getElementById("messengerAddress")!.innerText = new TextDecoder().decode(decodeBase32(window.hydrafiles.services.addHostname((req) => {
		console.log(req);
		const signature = req.headers.get("hydra-signature");
		const from = req.headers.get("hydra-from");
		if (signature === null || from === null) return new Response("Request not signed");
		if (!window.hydrafiles.rtcWallet.verifyMessage(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }), signature as `0x${string}`, from as `0x${string}`)) return new Response("Invalid signature");

		const params = new URL(req.url).searchParams;
		const message = params.get("message");
		const nonce = params.get("nonce");
		if (!message || !nonce) return new Response("Invalid message");
		if (seenMessages.has(message + nonce)) return new Response("Received message");
		seenMessages.add(message + nonce);
		messageBox.innerHTML += `<div class="col-start-6 col-end-13 p-3 rounded-lg">
			<div class="flex items-center justify-start">
				<div class="flex items-center justify-center h-10 w-10 rounded-full bg-indigo-500 flex-shrink-0">${from.slice(0, 4)}</div>
				<div class="relative mr-3 text-sm bg-indigo-100 py-2 px-4 shadow rounded-xl">
					<div>${message}</div>
				</div>
			</div>
		</div>`;
		return new Response("Received message");
	}, 200 + Object.keys(window.hydrafiles.services).length)));

	refreshHostnameUIs();
});

const tickHandler = async () => {
	try {
		(document.getElementById("uptime") as HTMLElement).innerHTML = convertTime(+new Date() - window.hydrafiles.startTime);
	} catch (e) {
		console.error(e);
	}
	try {
		(document.getElementById("peersCount") as HTMLElement).innerHTML = String(window.hydrafiles.rpcPeers.getPeers().length);
	} catch (e) {
		console.error(e);
	}
	try {
		(document.getElementById("knownFiles") as HTMLElement).innerHTML = `${await window.hydrafiles.files.db.count()} (${Math.round((100 * (await window.hydrafiles.files.db.sum("size"))) / 1024 / 1024 / 1024) / 100}GB)`;
	} catch (e) {
		console.error(e);
	}
	try {
		const files = await window.hydrafiles.fs.readDir("files/");
		const usedStorage = await window.hydrafiles.utils.calculateUsedStorage();
		(document.getElementById("storedFiles") as HTMLElement).innerHTML = `${files instanceof ErrorNotInitialised ? 0 : files.length} (${
			Math.round((100 * (usedStorage instanceof ErrorNotInitialised ? 0 : usedStorage)) / 1024 / 1024 / 1024) / 100
		}GB)`, populateTable();
	} catch (e) {
		console.error(e, (e as Error).stack);
	}
	try {
		(document.getElementById("downloadsServed") as HTMLElement).innerHTML = (await window.hydrafiles.files.db.sum("downloadCount")) +
			` (${Math.round((((await window.hydrafiles.files.db.sum("downloadCount * size")) / 1024 / 1024 / 1024) * 100) / 100)}GB)`;
	} catch (e) {
		console.error(e);
	}
	try {
		(document.getElementById("filesWallet") as HTMLElement).innerHTML = window.hydrafiles.filesWallet.address();
	} catch (e) {
		console.error(e);
	}
	try {
		(document.getElementById("rtcWallet") as HTMLElement).innerHTML = window.hydrafiles.rtcWallet.address();
	} catch (e) {
		console.error(e);
	}
	try {
		(document.getElementById("balance") as HTMLElement).innerHTML = String(await window.hydrafiles.filesWallet.balance());
	} catch (e) {
		console.error(e);
	}
	try {
		fetchAndPopulatePeers();
	} catch (e) {
		console.error(e);
	}
	fetchAndPopulateCharts();
	try {
		populateNetworkGraph();
	} catch (e) {
		console.error(e);
	}
	try {
		const blocks = window.hydrafiles.nameService.blocks;
		const knownServices = document.getElementById("knownServices")!;
		knownServices.innerHTML = "";
		for (let i = 0; i < blocks.length; i++) {
			const h3 = document.createElement("h3");
			h3.innerText = `Block ${i}`;
			h3.classList.add("text-lg", "font-bold");
			knownServices.appendChild(h3);
			const code = document.createElement("code");
			code.classList.add("text-sm");
			code.innerHTML = `Address or Script: ${blocks[i].content}<br>Name: ${blocks[i].name}<br>Signature or Hash: ${blocks[i].id}<br>Nonce: ${blocks[i].nonce}<br>Prev: ${blocks[i].prev}`;
			if (!blocks[i].content.startsWith("0x")) {
				const addService = document.createElement("button");
				addService.innerText = "Add Service";
				addService.classList.add("block", "px-4", "py-2", "bg-blue-600", "text-white", "rounded", "hover:bg-blue-700", "focus:outline-none", "focus:ring-2", "focus:ring-blue-500", "focus:ring-opacity-50");
				addService.addEventListener(
					"click",
					() => window.hydrafiles.services.addHostname(new Function("req", `return (${blocks[i].content})(req)`) as (req: Request) => Promise<Response>, 100 + Object.keys(window.hydrafiles.services.ownedServices).length),
				);
				knownServices.appendChild(addService);
			}
			knownServices.appendChild(code);
		}
	} catch (e) {
		console.error(e);
	}
	try {
		refreshHostnameUIs();
	} catch (e) {
		console.error(e);
	}
};

let hideAdvancedColumns = true;
const advancedColumns = ["hash", "infohash", "id", "found", "voteHash", "voteNonce", "downloadCount"];

// function restartHydrafiles(config: Config) {
// 	hydrafiles = new Hydrafiles(config);
// 	hydrafiles.start();
// }

// const configEl = document.getElementById("config") as HTMLElement;

// const options = Object.keys(hydrafiles.config);
// for (let i = 0; i < options.length; i++) {
// 	const option = options[i] as keyof typeof hydrafiles.config;
// 	const value = hydrafiles.config[option];

// 	// Create the main container div for each configuration item
// 	const configItem = document.createElement("div");
// 	configItem.classList.add("block", "overflow-hidden", "rounded-md", "border", "border-gray-200", "px-3", "py-2", "shadow-sm", "focus-within:border-blue-600", "focus-within:ring-1", "focus-within:ring-blue-600", "my-1");

// 	// Create the heading (label) for each configuration option
// 	const configHeading = document.createElement("span");
// 	configHeading.classList.add("text-xs", "font-medium", "text-gray-700");
// 	configHeading.innerText = option;

// 	// Create the input element with Tailwind styles
// 	const configInput = document.createElement("input");
// 	configInput.type = "text";
// 	configInput.value = String(value);
// 	configInput.id = `config-${option}`;
// 	configInput.classList.add("mt-1", "w-full", "border-none", "p-0", "focus:border-transparent", "focus:outline-none", "focus:ring-0", "sm:text-sm", "bg-none");

// 	// Add an event listener to handle updates to the configuration value
// 	configInput.addEventListener("change", (event) => {
// 		const target = event.target as HTMLInputElement;
// 		hydrafiles.config[option] = target.value as never;
// 	});

// 	// Append the label and input to the config item container
// 	configItem.appendChild(configHeading);
// 	configItem.appendChild(configInput);

// 	// Append the completed config item to the main container
// 	configEl.appendChild(configItem);
// }

// document.getElementById("saveConfig")!.addEventListener("click", () => {
// 	const inputs = document.querySelectorAll("#config input");
// 	inputs.forEach((input) => {
// 		const key = input.id.replace("config-", "") as keyof typeof hydrafiles.config;
// 		hydrafiles.config[key] = (input as HTMLInputElement).value as never;
// 	});
// 	restartHydrafiles(hydrafiles.config);
// });

const onUpdateFileListProgress = (progress: number, total: number) => {
	const syncFilesProgress = document.getElementById("syncFilesProgress") as HTMLElement;
	syncFilesProgress.innerHTML = `Syncing files: ${progress}/${total} (${((progress / total) * 100).toFixed(2)}%)`;
};

document.getElementById("toggleColumnsButton")!.addEventListener("click", () => {
	hideAdvancedColumns = !hideAdvancedColumns;
	console.log("Hide Advanced Columns:", hideAdvancedColumns);
	populateTable();
});

function getBackgroundColor(state: string): string {
	switch (state) {
		case "connected":
		case "complete":
		case "open":
			return "lightgreen";
		case "gathering":
		case "connecting":
		case "checking":
		case "have-local-offer":
		case "have-remote-offer":
			return "#FFD580";
		case "new":
		case "stable":
			return "lightblue";
		case "disconnected":
		case "closed":
		case "failed":
			return "lightcoral";
		default:
			return "white";
	}
}

async function fetchAndPopulatePeers() {
	const peers = window.hydrafiles.rpcPeers.getPeers();
	const peersEl = document.getElementById("httpPeers") as HTMLElement;
	peersEl.innerHTML = "";

	peers.forEach((node: { host: string }) => {
		const li = document.createElement("li");
		li.textContent = node.host;
		peersEl.appendChild(li);
	});

	const rtcPeers = Object.entries(window.hydrafiles.rpcPeers.peers);
	const tbody = document.getElementById("peerTable")!.querySelector("tbody") as HTMLTableSectionElement;

	tbody.innerHTML = "";
	rtcPeers.forEach(([id, peer]) => {
		const peerConns = Object.entries(peer);
		peerConns.forEach(([type, peerConn]) => {
			const conn = peerConn.conn;
			const row = document.createElement("tr");

			const cells = [
				id,
				type,
				conn.signalingState,
				conn.iceGatheringState,
				conn.iceConnectionState,
				conn.connectionState,
				peerConn.channel.readyState,
				conn.connectionState || "N/A",
			];

			cells.forEach((text) => {
				const cell = document.createElement("td");
				cell.textContent = text;
				cell.style.backgroundColor = getBackgroundColor(text);
				row.appendChild(cell);
			});

			tbody.appendChild(row);
		});
	});
}

function populateTable() {
	const tableHeader = document.getElementById("table-header") as HTMLTableRowElement;
	const tableBody = document.querySelector("#files  tbody") as HTMLTableSectionElement;
	tableBody.innerHTML = "";

	const files = window.hydrafiles.files.getFiles();

	if (files.length === 0) return;

	const fileKeys = Object.keys(files[0]) as (keyof FileAttributes)[];
	tableHeader.innerHTML = "";
	fileKeys.forEach((key) => {
		if (!(hideAdvancedColumns && advancedColumns.includes(key))) {
			const th = document.createElement("th");
			th.textContent = key;
			tableHeader.appendChild(th);
		}
	});

	const actionsHeader = document.createElement("th");
	actionsHeader.textContent = "Actions";
	tableHeader.appendChild(actionsHeader);

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const row = document.createElement("tr");

		for (let j = 0; j < fileKeys.length; j++) {
			const key = fileKeys[j];
			if (!(hideAdvancedColumns && advancedColumns.includes(key))) {
				const cell = document.createElement("td");
				let value = file[key];

				if (key === "size") value = `${(file[key] / (1024 * 1024)).toFixed(2)} MB`;
				if (key === "updatedAt") value = new Date(file[key]).toLocaleDateString();

				cell.textContent = String(value);
				row.appendChild(cell);
			}
		}

		const actionsCell = document.createElement("td");
		actionsCell.className = "file-actions";
		const button = document.createElement("button");
		button.textContent = "Download";
		button.addEventListener("click", async () => {
			console.log("Downloading file:", file);
			const fileContent = await file.getFile({ logDownloads: true });
			if (!fileContent) {
				console.error("Failed to download file");
				return;
			}
			if (fileContent instanceof Error) return;
			const url = URL.createObjectURL(new Blob([fileContent.file], { type: "application/octet-stream" }));
			const a = document.createElement("a");
			a.href = url;
			if (file.name) a.download = file.name;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		});
		actionsCell.appendChild(button);
		row.appendChild(actionsCell);

		tableBody.appendChild(row);
	}
}

let chartInstances: { [key: string]: Chart } = {};

function fetchAndPopulateCharts() {
	const tables = window.hydrafiles.events.logs;
	for (const table in tables) {
		const data = tables[table as keyof typeof tables];
		populateChart(table, data);
	}
}

const colorGen = new ColorGenerator();

function populateChart(name: string, data: Record<FileEvent, number[]> | Record<RTCEvent, number[]>) {
	const events = Object.keys(data);
	const defaultColors = colorGen.generateColors(events.length + 1);
	const datasets = events.map((event, index) => ({
		label: event,
		data: data[event as keyof typeof data],
		backgroundColor: defaultColors[index],
		fill: true,
	}));

	const maxLength = Math.max(...events.map((event) => (data[event as keyof typeof data] as number[]).length));
	const labels = Array.from({ length: maxLength }, (_, i) => i.toString());

	if (!chartInstances[name]) {
		const canvas = document.createElement("canvas");
		canvas.id = name;
		document.getElementById("charts")!.appendChild(canvas);
		const lineChartCtx = (document.getElementById(name) as HTMLCanvasElement).getContext("2d")!;
		chartInstances[name] = new Chart(lineChartCtx, {
			type: "line",
			data: { labels, datasets },
			options: {
				responsive: true,
				plugins: { legend: { position: "top" } },
				scales: {
					y: { stacked: true, beginAtZero: true },
				},
			},
		});
	} else {
		chartInstances[name].data.labels = labels;
		chartInstances[name].data.datasets.forEach((dataset, index) => {
			dataset.data = datasets[index].data;
		});
		chartInstances[name].update();
	}
}

document.addEventListener("DOMContentLoaded", async () => {
	const savedCredentials = loadSavedCredentials();
	if (savedCredentials) {
		(document.getElementById("email") as HTMLInputElement).value = savedCredentials.email;
		(document.getElementById("password") as HTMLInputElement).value = savedCredentials.password;
		(document.getElementById("rememberMe") as HTMLInputElement).checked = true;
	}

	document.getElementById("createHandler")!.addEventListener("click", () => {
		const index = Object.keys(window.hydrafiles.services.ownedServices).length;
		window.hydrafiles.services.addHostname(
			new Function("req", `return (async (req) => new Response('Hello World!'))(req)`) as (req: Request) => Promise<Response>,
			index,
		);

		refreshHostnameUIs();

		const results = document.getElementById("testResults") as HTMLElement;
		results.classList.remove("hidden");
		results.classList.remove("bg-red-50", "text-red-800");
		results.classList.add("bg-green-50", "text-green-800");
		results.textContent = "Service Created Successfully!";

		setTimeout(() => results.classList.add("hidden"), 3000);
	});

	const pages = ["documentation", "statistics", "peers", "files", "services", "chat", "browser"];
	const sidebarLinks = document.querySelectorAll("#default-sidebar a");

	const selectPage = (pageId: string) => {
		pages.forEach((id) => {
			if (id !== "documentation") (document.getElementById(id) as HTMLElement).classList.add("hidden");
		});
		(document.getElementById(pageId) as HTMLElement).classList.remove("hidden");

		sidebarLinks.forEach((link) => link.classList.remove("bg-gray-100", "dark:bg-gray-700"));
		const activeLink = Array.from(sidebarLinks).find((link) => link.getAttribute("data-section") === pageId);
		if (activeLink) activeLink.classList.add("bg-gray-100", "dark:bg-gray-700");
	};

	for (let i = 0; i < sidebarLinks.length; i++) {
		const link = sidebarLinks[i];
		link.setAttribute("data-section", pages[i]);
		link.addEventListener("click", (e) => {
			if (pages[i] !== "documentation") e.preventDefault();
			selectPage(link.getAttribute("data-section") as string);
		});
	}

	document.getElementById("sendMessage")!.addEventListener("click", () => {
		const message = (document.getElementById("message") as HTMLInputElement).value;
		const messageBox = document.getElementById("messages") as HTMLElement;
		const messengerAddress = document.getElementById("messengerAddress")!.innerText;
		const wallet = window.hydrafiles.services.ownedServices[encodeBase32(new TextEncoder().encode(messengerAddress)).toUpperCase()].wallet;

		messageBox.innerHTML += `<div class="col-start-6 col-end-13 p-3 rounded-lg">
			<div class="flex items-center justify-start flex-row-reverse">
				<div class="flex items-center justify-center h-10 w-10 rounded-full bg-indigo-500 flex-shrink-0">${messengerAddress.slice(0, 4)}</div>
				<div class="relative mr-3 text-sm bg-indigo-100 py-2 px-4 shadow rounded-xl">
					<div>${message}</div>
				</div>
			</div>
		</div>`;
		window.hydrafiles.rpcPeers.fetch(
			new URL(`https://localhost/service/${(document.getElementById("peerAddress") as HTMLInputElement).value}?message=${encodeURIComponent(message)}&nonce=${Math.random()}`),
			{ wallet },
		);
	});

	document.getElementById("loadSite")!.addEventListener("click", async () => {
		document.getElementById("loadSite")!.innerHTML =
			`<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;

		const response = await window.hydrafiles.rpcPeers.exitFetch(new Request((document.getElementById("urlInput") as HTMLInputElement).value));
		try {
			if (!(response instanceof Error)) {
				const body = response.body;
				console.log("body", body);
				document.getElementById("urlBody")!.innerHTML = body;
			}
		} catch (error) {
			console.error("Error loading site:", error);
			document.getElementById("urlBody")!.innerHTML = `Error loading site: ${(error as Error).message}`;
		}
		document.getElementById("loadSite")!.innerHTML = "Go";
	});

	selectPage("statistics");
});

// Add this after other interface declarations
interface HostnameUI {
	name: string;
	handler: string;
	element: HTMLElement;
}

// Add this to store hostname UIs
const hostnameUIs = new Map<string, HostnameUI>();

// Add this function to create UI for a hostname
async function createHostnameUI(hostname: EthAddress): Promise<HostnameUI> {
	const container = document.createElement("section");
	container.className = "mb-8 p-4 border rounded-lg";

	const endpoint = document.createElement("p");
	endpoint.className = "text-sm text-gray-600 mt-1 mb-4";
	endpoint.innerHTML = `Endpoint: <code class="bg-gray-100 px-2 py-1 rounded">https://${window.location.hostname}/service/${hostname}</code>`;

	const textarea = document.createElement("textarea");
	textarea.className = "w-full h-48 mt-2 p-4 font-mono text-sm border rounded focus:outline-none focus:border-blue-500";
	textarea.value = formatTSCode(window.hydrafiles.services.ownedServices[encodeBase32(hostname)].requestHandler.toString());

	const nameInput = document.createElement("input");
	nameInput.className = "w-full my-2 p-4 font-mono text-sm border rounded focus:outline-none focus:border-blue-500";
	nameInput.placeholder = "Name";
	nameInput.required = true;

	const results = document.createElement("div");
	results.className = "hidden my-4 p-4 rounded-lg";

	const updateButton = document.createElement("button");
	updateButton.className = "px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50";
	updateButton.textContent = "Update Handler";

	const announceServiceButton = document.createElement("button");
	announceServiceButton.className = "px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50";
	announceServiceButton.textContent = "Announce Service";

	const publishSourceButton = document.createElement("button");
	publishSourceButton.className = "px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50";
	publishSourceButton.textContent = "Publish Source";

	updateButton.addEventListener("click", () => {
		try {
			const code = textarea.value;
			window.hydrafiles.services.ownedServices[encodeBase32(hostname)].requestHandler = new Function("req", `return (${code})(req)`) as (req: Request) => Promise<Response>;
			results.textContent = "Handler updated successfully!";
			results.className = "my-4 p-4 rounded-lg bg-green-50 text-green-800";
			setTimeout(() => results.className = "hidden", 3000);
		} catch (err) {
			results.textContent = `Error updating handler: ${(err as Error).message}`;
			results.className = "my-4 p-4 rounded-lg bg-red-50 text-red-800";
		}
	});

	announceServiceButton.addEventListener("click", () => {
		try {
			window.hydrafiles.services.ownedServices[encodeBase32(hostname)].announce(nameInput.value);
			results.textContent = "Announced Service!";
			results.className = "my-4 p-4 rounded-lg bg-green-50 text-green-800";
			setTimeout(() => results.className = "hidden", 3000);
		} catch (err) {
			results.textContent = `Error updating handler: ${(err as Error).message}`;
			results.className = "my-4 p-4 rounded-lg bg-red-50 text-red-800";
		}
	});

	publishSourceButton.addEventListener("click", () => {
		try {
			window.hydrafiles.nameService.createBlock({ script: textarea.value }, nameInput.value);
			results.textContent = "Published Source!";
			results.className = "my-4 p-4 rounded-lg bg-green-50 text-green-800";
			setTimeout(() => results.className = "hidden", 3000);
		} catch (err) {
			results.textContent = `Error updating handler: ${(err as Error).message}`;
			results.className = "my-4 p-4 rounded-lg bg-red-50 text-red-800";
		}
	});

	container.appendChild(endpoint);
	container.appendChild(textarea);
	container.appendChild(nameInput);
	container.appendChild(results);
	container.appendChild(updateButton);
	container.appendChild(announceServiceButton);
	container.appendChild(publishSourceButton);

	return {
		name: hostname,
		handler: textarea.value,
		element: container,
	};
}

// Update this function to refresh hostname UIs
async function refreshHostnameUIs() {
	const services = window.hydrafiles.services.ownedServices;
	const servicesContainer = document.getElementById("servicesList")!;

	// Clear existing service sections except the header
	const header = servicesContainer.querySelector("h2");
	servicesContainer.innerHTML = "";
	if (header) servicesContainer.appendChild(header);

	// Create/update UI for each hostname
	Object.keys(services).forEach(async (hostname) => {
		if (!hostnameUIs.has(hostname)) {
			const ui = await createHostnameUI(new TextDecoder().decode(decodeBase32(hostname)) as EthAddress);
			hostnameUIs.set(hostname, ui);
		}
		servicesContainer.appendChild(hostnameUIs.get(hostname)!.element);
	});
}

const nodes = new DataSet<Node>([{ id: 0, label: "You" }]);
const edges = new DataSet<Edge>([]);
const network = new Network(document.getElementById("peerNetwork")!, { nodes: nodes as any, edges: edges as any }, {
	nodes: {
		shape: "dot",
		scaling: {
			customScalingFunction: function (min, max, total, value) {
				console.log(min, max, total, value);
				return (value ?? 0) / (total ?? 0);
			},
			min: 5,
			max: 150,
		},
	},
});

async function populateNetworkGraph() {
	const peers = Array.from(window.hydrafiles.rpcPeers.peers);

	const foundNodes = [
		...peers.map((peer, index) => ({ id: index + 1, label: peer[0] })),
	];
	const foundEdges = [
		...peers.map((_, index) => ({ id: `0-${index + 1}`, from: 0, to: index + 1 })),
	];

	foundNodes.forEach((node) => {
		if (!nodes.get(node.id)) nodes.add(node);
	});
	foundEdges.forEach((edge) => {
		if (!edges.get(edge.id)) edges.add(edge);
	});

	const responses = await Promise.all(peers.map((peer) => Utils.promiseWithTimeout(fetch(`${peer[0]}/peers`), 10000)));
	for (const response of responses) {
		if (response instanceof Error) continue;

		const url = new URL(response.url);
		const peer = `${url.protocol}//${url.hostname}`;

		const body = await response.text();
		try {
			const peers = JSON.parse(body);

			for (let i = 0; i < peers.length; i++) {
				const fromNode = nodes.get().find((node) => node.label === peer);
				const toNode = nodes.get().find((node) => node.label === peers[i].host);
				if (fromNode && toNode && !edges.get(`${fromNode.id}-${toNode.id}`)) edges.add({ id: `${fromNode.id}-${toNode.id}`, from: fromNode.id, to: toNode.id });
			}
		} catch (_) {
			continue;
		}
	}
}
