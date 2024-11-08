enum FileEvent {
	FileServed = "FileServed",
	FileNotFound = "FileNotFound",
}

enum RTCEvent {
	RTCAnnounce = "RTCAnnounce",
	RTCOpen = "RTCOpen",
	RTCOffer = "RTCOffer",
	RTCAnswer = "RTCAnswer",
	RTCIce = "RTCIce",
	RTCClose = "RTCClose",
}

interface EventsLogs {
	file: Record<FileEvent, Record<number, number>>;
	rtc: Record<RTCEvent, Record<number, number>>;
}

class Events {
	interval = 5;
	lastInterval = 0;
	startTime: number;
	logs: EventsLogs = {
		file: {
			[FileEvent.FileServed]: {},
			[FileEvent.FileNotFound]: {},
		},
		rtc: {
			[RTCEvent.RTCAnnounce]: {},
			[RTCEvent.RTCOpen]: {},
			[RTCEvent.RTCOffer]: {},
			[RTCEvent.RTCAnswer]: {},
			[RTCEvent.RTCIce]: {},
			[RTCEvent.RTCClose]: {},
		},
	};
	fileEvents = FileEvent;
	rtcEvents = RTCEvent;

	constructor() {
		this.startTime = +new Date();
	}

	public log = (event: FileEvent | RTCEvent) => {
		const interval = Math.floor((+new Date() - this.startTime) / 1000 / this.interval);

		for (let i = this.lastInterval + 1; i < interval; i++) {
			Object.values(FileEvent).forEach((fileEvent) => {
				if (!this.logs["file"][fileEvent][i]) this.logs["file"][fileEvent][i] = 0;
			});
			Object.values(RTCEvent).forEach((rtcEvent) => {
				if (!this.logs["rtc"][rtcEvent][i]) this.logs["rtc"][rtcEvent][i] = 0;
			});
		}

		if (Object.values(FileEvent).includes(event as FileEvent)) {
			if (!this.logs["file"][event as FileEvent][interval]) this.logs["file"][event as FileEvent][interval] = 0;
			this.logs["file"][event as FileEvent][interval]++;
		} else if (Object.values(RTCEvent).includes(event as RTCEvent)) {
			if (!this.logs["rtc"][event as RTCEvent][interval]) this.logs["rtc"][event as RTCEvent][interval] = 0;
			this.logs["rtc"][event as RTCEvent][interval]++;
		}

		this.lastInterval = interval;
	};
}

export default Events;
