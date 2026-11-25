import { ClientCoreError } from "@launchpad-kit/client-core";
import type { Io } from "./io";

// The controller's own limits (`packages/auth`): 12 to 128 characters.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const bad = (message: string) => new ClientCoreError("bad-input", message);

// A password comes from a hidden terminal prompt or a `--password-file`, never an argument
// or the environment. It is checked here, before any request, and never put in a message.
export async function readPassword(
    io: Io,
    options: { passwordFile?: string; prompt: string; signal?: AbortSignal },
): Promise<string> {
    let password: string;
    if (options.passwordFile !== undefined) {
        try {
            password = await io.readPasswordFile(options.passwordFile);
        } catch (error) {
            throw bad(error instanceof Error ? error.message : "The password file cannot be read.");
        }
    } else if (io.interactive) {
        try {
            password = await io.readSecret(options.prompt, {
                kind: "password",
                signal: options.signal,
            });
        } catch (error) {
            if (error instanceof Error && /^(Cancelled\.|Input is too long)/.test(error.message)) {
                throw bad(error.message);
            }
            throw error;
        }
    } else {
        throw bad(
            "There is no terminal to ask for the password: provide --password-file <path> or run in a terminal.",
        );
    }
    if (password.length === 0) throw bad("The password is empty.");
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw bad(
            `The password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
        );
    }
    return password;
}
