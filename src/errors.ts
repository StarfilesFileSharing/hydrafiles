import Utils from "./utils.ts";

export class ErrorTimeout extends Error {
	readonly brand = Symbol();
}
export class ErrorNotFound extends Error {
	// constructor() {
	// 	super("Error of type ErrorNotFound' thrown");
	// 	Utils.error("ErrorNotFound", this.stack);
	// }
	readonly brand = Symbol();
}
export class ErrorMissingRequiredProperty extends Error {
	constructor(msg?: string) {
		super(msg);
		Utils.error("ErrorMissingRequiredProperty", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorUnreachableCodeReached extends Error {
	constructor() {
		super("Error of type 'ErrorUnreachableCodeReached' thrown");
		Utils.error("ErrorUnreachableCodeReached", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorNotInitialised extends Error {
	constructor() {
		super("Error of type 'ErrorNotInitialised' thrown");
		Utils.error("ErrorNotInitialised", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorWrongDatabaseType extends Error {
	constructor() {
		super("Error of type 'ErrorWrongDatabaseType' thrown");
		Utils.error("ErrorWrongDatabaseType", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorChecksumMismatch extends Error {
	constructor() {
		super("Error of type 'ErrorChecksumMismatch' thrown");
		Utils.error("ErrorChecksumMismatch", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorRequestFailed extends Error {
	readonly brand = Symbol();
}
export class ErrorDownloadFailed extends Error {
	constructor(msg?: string) {
		super(msg);
	}
	readonly brand = Symbol();
}
export class ErrorFailedToReadFile extends Error {
	constructor(msg?: string) {
		super(msg);
		Utils.error("ErrorFailedToReadFile", this.stack);
	}
	readonly brand = Symbol();
}

export class ErrorInsufficientBalance extends Error {
	readonly brand = Symbol();
}

export class ErrorUnexpectedProtocol extends Error {
	constructor() {
		super("Error of type 'ErrorUnexpectedProtocol' thrown");
		Utils.error("ErrorUnexpectedProtocol", this.stack);
	}
	readonly brand = Symbol();
}
