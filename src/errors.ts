export class ErrorTimeout extends Error {
	readonly brand = Symbol();
}
export class ErrorNotFound extends Error {
	// constructor() {
	// 	super("Error of type ErrorNotFound' thrown");
	// 	console.error("ErrorNotFound", this.stack);
	// }
	readonly brand = Symbol();
}
export class ErrorMissingRequiredProperty extends Error {
	constructor(msg?: string) {
		super(msg);
		console.error("ErrorMissingRequiredProperty", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorUnreachableCodeReached extends Error {
	constructor() {
		super("Error of type 'ErrorUnreachableCodeReached' thrown");
		console.error("ErrorUnreachableCodeReached", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorNotInitialised extends Error {
	constructor() {
		super("Error of type 'ErrorNotInitialised' thrown");
		console.error("ErrorNotInitialised", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorWrongDatabaseType extends Error {
	constructor() {
		super("Error of type 'ErrorWrongDatabaseType' thrown");
		console.error("ErrorWrongDatabaseType", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorChecksumMismatch extends Error {
	constructor() {
		super("Error of type 'ErrorChecksumMismatch' thrown");
		console.error("ErrorChecksumMismatch", this.stack);
	}
	readonly brand = Symbol();
}
export class ErrorRequestFailed extends Error {
	constructor(msg?: string) {
		super(msg);
		console.error("ErrorRequestFailed", this.stack);
	}
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
		console.error("ErrorFailedToReadFile", this.stack);
	}
	readonly brand = Symbol();
}

export class ErrorInsufficientBalance extends Error {
	readonly brand = Symbol();
}

export class ErrorUnexpectedProtocol extends Error {
	constructor() {
		super("Error of type 'ErrorUnexpectedProtocol' thrown");
		console.error("ErrorUnexpectedProtocol", this.stack);
	}
	readonly brand = Symbol();
}
