export class OperatorExistsError extends Error {
    constructor() {
        super("An operator already exists; use the recovery command instead.");
        this.name = "OperatorExistsError";
    }
}

export class InvalidSetupInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidSetupInputError";
    }
}
