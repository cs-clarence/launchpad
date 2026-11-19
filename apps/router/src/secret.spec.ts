import { symlinkSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readSecretFile, readSecretStdin, SecretError } from "./secret";
import { newToken, secretFile, tempState, type TempState } from "./test-support";

let state: TempState;
afterEach(() => state?.cleanup());

function failure(action: () => unknown): SecretError {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(SecretError);
        return error as SecretError;
    }
    throw new Error("Expected a SecretError.");
}

describe("readSecretFile", () => {
    it("reads a 0600 file and strips one trailing newline", () => {
        state = tempState();
        const token = newToken();
        expect(readSecretFile(secretFile(state.directory, `${token}\n`))).toBe(token);
        expect(readSecretFile(secretFile(state.directory, token, 0o600, "t2"))).toBe(token);
        expect(readSecretFile(secretFile(state.directory, `${token}\r\n`, 0o600, "t3"))).toBe(
            token,
        );
    });

    it.each([0o644, 0o640, 0o604, 0o660])("refuses mode %o", (mode) => {
        state = tempState();
        const file = secretFile(state.directory, newToken(), mode);
        expect(failure(() => readSecretFile(file)).message).toContain("readable only by you");
    });

    it("refuses symlinks, directories, missing files and unusual paths", () => {
        state = tempState();
        const real = secretFile(state.directory, newToken());
        const link = path.join(state.directory, "link");
        symlinkSync(real, link);
        failure(() => readSecretFile(link));
        failure(() => readSecretFile(state.directory));
        failure(() => readSecretFile(path.join(state.directory, "missing")));
        failure(() => readSecretFile("relative"));
        failure(() => readSecretFile("/tmp/../etc/passwd"));
        failure(() => readSecretFile("/tmp/with space"));
    });

    it("refuses oversized and malformed secrets without echoing them", () => {
        state = tempState();
        const wrong = "Z".repeat(64);
        for (const content of [
            wrong,
            "abc",
            "",
            `${newToken()}x`,
            newToken().toUpperCase(),
            "x".repeat(300),
        ]) {
            const file = secretFile(state.directory, content);
            const error = failure(() => readSecretFile(file));
            expect(error.message).not.toContain(content.slice(0, 20) || "\0");
        }
    });
});

describe("readSecretStdin", () => {
    it("reads a piped secret", async () => {
        const token = newToken();
        expect(await readSecretStdin(Readable.from([Buffer.from(`${token}\n`)]))).toBe(token);
    });

    it("refuses a terminal, oversized or malformed input", async () => {
        const terminal = Object.assign(Readable.from([Buffer.from(newToken())]), { isTTY: true });
        await expect(readSecretStdin(terminal)).rejects.toThrow("terminal");
        await expect(readSecretStdin(Readable.from([Buffer.alloc(300, "a")]))).rejects.toThrow(
            "too large",
        );
        await expect(readSecretStdin(Readable.from([Buffer.from("nope")]))).rejects.toThrow(
            "64 lowercase",
        );
    });
});
