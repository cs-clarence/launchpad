export type ClientCoreErrorCode =
    | "not-logged-in"
    | "insecure-store"
    | "corrupt-store"
    | "unsupported-store"
    | "store-unavailable"
    | "store-busy"
    | "bad-input"
    | "no-organization";

// Messages never contain an API key or the file's contents.
export class ClientCoreError extends Error {
    readonly code: ClientCoreErrorCode;

    constructor(code: ClientCoreErrorCode, message: string) {
        super(message);
        this.name = "ClientCoreError";
        this.code = code;
    }
}
