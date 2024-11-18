import Hydrafiles from "../src/hydrafiles.ts";
import { type FileAttributes } from "../src/file.ts";
import WebTorrent from "https://esm.sh/webtorrent@2.5.1";
import { Chart } from "https://esm.sh/chart.js@4.4.6/auto";
import { ErrorNotInitialised } from "../src/errors.ts";
import type { FileEventLog, RTCEventLog } from "../src/events.ts";

declare global {
	interface Window {
		hydrafiles: Hydrafiles;
	}
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

	window.hydrafiles = new Hydrafiles({ deriveKey });
	const webtorrent = new WebTorrent();

	await window.hydrafiles.start({ onUpdateFileListProgress, webtorrent });
	console.log("Hydrafiles web node is running", window.hydrafiles);
	setInterval(tickHandler, 30 * 1000);
	tickHandler();
});

const tickHandler = async () => {
	try {
		const usedStorage = await window.hydrafiles.utils.calculateUsedStorage();
		try {
			const files = await window.hydrafiles.fs.readDir("files/");
			try {
				(document.getElementById("uptime") as HTMLElement).innerHTML = convertTime(+new Date() - window.hydrafiles.startTime);
			} catch (e) {
				console.error(e);
			}
			try {
				(document.getElementById("httpPeersCount") as HTMLElement).innerHTML = String(window.hydrafiles.rpcClient.http.getPeers().length);
			} catch (e) {
				console.error(e);
			}
			try {
				(document.getElementById("rtcPeers") as HTMLElement).innerHTML = String(Object.keys(window.hydrafiles.rpcClient.rtc.peerConnections).length);
			} catch (e) {
				console.error(e);
			}
			try {
				(document.getElementById("apiEndpoint") as HTMLElement).textContent = `https://hydrafiles.com/endpoint/${window.hydrafiles.apiWallet.address()}`;
			} catch (e) {
				console.error(e);
			}
			try {
				(document.getElementById("knownFiles") as HTMLElement).innerHTML = `${await window.hydrafiles.files.db.count()} (${Math.round((100 * (await window.hydrafiles.files.db.sum("size"))) / 1024 / 1024 / 1024) / 100}GB)`;
			} catch (e) {
				console.error(e);
			}
			try {
				(document.getElementById("storedFiles") as HTMLElement).innerHTML = `${files instanceof ErrorNotInitialised ? 0 : files.length} (${
					Math.round((100 * (usedStorage instanceof ErrorNotInitialised ? 0 : usedStorage)) / 1024 / 1024 / 1024) / 100
				}GB)`, populateTable();
			} catch (e) {
				console.error(e);
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
		} catch (e) {
			console.error(e);
		}
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
	const peers = window.hydrafiles.rpcClient.http.getPeers();
	const peersEl = document.getElementById("httpPeers") as HTMLElement;
	peersEl.innerHTML = "";

	peers.forEach((node: { host: string }) => {
		const li = document.createElement("li");
		li.textContent = node.host;
		peersEl.appendChild(li);
	});

	const rtcPeers = Object.entries(window.hydrafiles.rpcClient.rtc.peerConnections);
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

	files.forEach((file) => {
		const row = document.createElement("tr");

		fileKeys.forEach((key) => {
			if (!(hideAdvancedColumns && advancedColumns.includes(key))) {
				const cell = document.createElement("td");
				let value = file[key];

				if (key === "size") value = `${(file[key] / (1024 * 1024)).toFixed(2)} MB`;
				if (key === "updatedAt") value = new Date(file[key]).toLocaleDateString();

				cell.textContent = String(value);
				row.appendChild(cell);
			}
		});

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
	});
}

let chartInstances: { [key: string]: Chart } = {};

function fetchAndPopulateCharts() {
	const tables = window.hydrafiles.events.logs;
	for (const table in tables) {
		const data = tables[table as keyof typeof tables];
		populateChart(table, data);
	}
}

function populateChart(name: string, data: FileEventLog | RTCEventLog) {
	const events = Object.keys(data);
	const datasets = events.map((label) => ({
		label,
		data: data[label as keyof typeof data],
		backgroundColor: getRandomColor(),
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

function getRandomColor(opacity = 1): string {
	const r = Math.floor(Math.random() * 255);
	const g = Math.floor(Math.random() * 255);
	const b = Math.floor(Math.random() * 255);
	return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

document.addEventListener("DOMContentLoaded", async () => {
	const savedCredentials = loadSavedCredentials();
	if (savedCredentials) {
		(document.getElementById("email") as HTMLInputElement).value = savedCredentials.email;
		(document.getElementById("password") as HTMLInputElement).value = savedCredentials.password;
		(document.getElementById("rememberMe") as HTMLInputElement).checked = true;
	}

	(document.getElementById("updateHandler") as HTMLElement).addEventListener("click", () => {
		try {
			const code = (document.getElementById("customHandler") as HTMLInputElement).value;
			window.hydrafiles.handleCustomRequest = new Function("req", `return (${code})(req)`) as (req: Request) => Promise<Response>;

			const results = document.getElementById("testResults") as HTMLElement;
			results.classList.remove("hidden");
			results.classList.remove("bg-red-50", "text-red-800");
			results.classList.add("bg-green-50", "text-green-800");
			results.textContent = "Handler updated successfully!";

			setTimeout(() => results.classList.add("hidden"), 3000);
		} catch (err) {
			const results = document.getElementById("testResults") as HTMLElement;
			results.classList.remove("hidden");
			results.classList.remove("bg-green-50", "text-green-800");
			results.classList.add("bg-red-50", "text-red-800");
			results.textContent = `Error updating handler: ${(err as Error).message}`;
		}
	});

	const pages = ["dashboard", "statistics", "peers", "files", "serveAPI"];
	const sidebarLinks = document.querySelectorAll("#default-sidebar a");

	const selectPage = (pageId: string) => {
		pages.forEach((id) => (document.getElementById(id) as HTMLElement).classList.add("hidden"));
		(document.getElementById(pageId) as HTMLElement).classList.remove("hidden");

		sidebarLinks.forEach((link) => link.classList.remove("bg-gray-100", "dark:bg-gray-700"));
		const activeLink = Array.from(sidebarLinks).find((link) => link.getAttribute("data-section") === pageId);
		if (activeLink) activeLink.classList.add("bg-gray-100", "dark:bg-gray-700");
	};

	for (let i = 0; i < sidebarLinks.length; i++) {
		const link = sidebarLinks[i];
		link.setAttribute("data-section", pages[i]);
		link.addEventListener("click", (e) => {
			e.preventDefault();
			selectPage(link.getAttribute("data-section") as string);
		});
	}

	selectPage("dashboard");
});
