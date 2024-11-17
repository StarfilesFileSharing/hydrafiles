export enum FileEvent {
	FileServed = "FileServed",
	FileNotFound = "FileNotFound",
}
export enum RTCEvent {
	RTCAnnounce = "RTCAnnounce",
	RTCOpen = "RTCOpen",
	RTCOffer = "RTCOffer",
	RTCAnswer = "RTCAnswer",
	RTCIce = "RTCIce",
	RTCTimeout = "RTCTimeout",
	RTCClose = "RTCClose",
}
export type FileEventLog = Record<FileEvent, number[]>;
export type RTCEventLog = Record<RTCEvent, number[]>;

class Events {
	interval = 10000;
	lastInterval = 0;
	startTime: number;
	logs = {
		file: {} as FileEventLog,
		rtc: {} as RTCEventLog,
	};
	fileEvents = FileEvent;
	rtcEvents = RTCEvent;

	constructor() {
		this.startTime = +new Date();
	}

	public log = (event: FileEvent | RTCEvent) => {
		const eventType = event.constructor.name;

		const interval = Math.floor((+new Date() - this.startTime) / this.interval);

		for (let i = 0; i < interval; i++) {
			(Object.keys(this.logs) as Array<keyof typeof this.logs>).forEach((key) => {
				(Object.keys(this.logs[key]) as Array<FileEvent | RTCEvent>).forEach((event) => {
					if (typeof (this.logs[key] as Record<FileEvent | RTCEvent, number[]>)[event][i] === "undefined") {
						(this.logs[key] as Record<FileEvent | RTCEvent, number[]>)[event][i] = 0;
					}
				});
			});
		}

		if (eventType in FileEvent) {
			const fileEvent = event as FileEvent;
			if (!(fileEvent in this.logs.file)) this.logs.file[fileEvent] = [];
			for (let i = this.logs.file[fileEvent].length; i < interval; i++) {
				this.logs.file[fileEvent][i] = 0;
			}
			if (!this.logs.file[fileEvent][interval]) this.logs.file[fileEvent][interval] = 0;
			this.logs.file[fileEvent][interval]++;
		} else if (event in RTCEvent) {
			const rtcEvent = event as RTCEvent;
			if (!(rtcEvent in this.logs.rtc)) this.logs.rtc[rtcEvent] = [];
			if (!this.logs.rtc[rtcEvent][interval]) this.logs.rtc[rtcEvent][interval] = 0;
			this.logs.rtc[rtcEvent][interval]++;
		}

		this.lastInterval = interval;
	};
}

export default Events;
