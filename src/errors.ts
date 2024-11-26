export class ErrorTimeout extends Error {
	readonly brand = Symbol();
}
export class ErrorNotFound extends Error {
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
	readonly brand = Symbol();
}
export class ErrorRequestFailed extends Error {
	readonly brand = Symbol();
}
export class ErrorDownloadFailed extends Error {
	constructor() {
		super("Error of type 'ErrorDownloadFailed' thrown");
		console.error("ErrorDownloadFailed", this.stack);
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
	constructor() {
		super("Error of type 'ErrorInsufficientBalance' thrown");
		console.error("ErrorInsufficientBalance", this.stack);
	}
	readonly brand = Symbol();
}

export class ErrorUnexpectedProtocol extends Error {
	readonly brand = Symbol();
}
