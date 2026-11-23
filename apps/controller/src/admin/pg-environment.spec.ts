import { describe, expect, it } from "vitest";
import { BackupError, createBackup, pgEnvironment } from "./backup";

describe("PostgreSQL client connection settings", () => {
    it("preserves encoded credentials and IPv6 addresses", () => {
        expect(pgEnvironment("postgresql://lp%40user:p%2Fw@[::1]:6543/launch")).toEqual({
            PGHOST: "::1",
            PGPORT: "6543",
            PGUSER: "lp@user",
            PGPASSWORD: "p/w",
            PGDATABASE: "launch",
        });
    });

    it("passes explicit PostgreSQL 17 TLS settings to libpq", () => {
        const options = Object.entries({
            sslmode: "verify-full",
            sslrootcert: "/private/CA %20.pem",
            sslcert: "/private/client.pem",
            sslkey: "/private/client.key",
            sslcrl: "/private/revocations.pem",
            sslcrldir: "/private/revocations",
            sslsni: "1",
            sslcompression: "0",
            sslcertmode: "require",
            sslnegotiation: "postgres",
            ssl_min_protocol_version: "TLSv1.2",
            ssl_max_protocol_version: "TLSv1.3",
            channel_binding: "require",
            gssencmode: "disable",
            connect_timeout: "10",
        })
            .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
            .join("&");
        expect(pgEnvironment(`postgres://db/launch?${options}`)).toEqual({
            PGHOST: "db",
            PGDATABASE: "launch",
            PGSSLMODE: "verify-full",
            PGSSLROOTCERT: "/private/CA %20.pem",
            PGSSLCERT: "/private/client.pem",
            PGSSLKEY: "/private/client.key",
            PGSSLCRL: "/private/revocations.pem",
            PGSSLCRLDIR: "/private/revocations",
            PGSSLSNI: "1",
            PGSSLCOMPRESSION: "0",
            PGSSLCERTMODE: "require",
            PGSSLNEGOTIATION: "postgres",
            PGSSLMINPROTOCOLVERSION: "TLSv1.2",
            PGSSLMAXPROTOCOLVERSION: "TLSv1.3",
            PGCHANNELBINDING: "require",
            PGGSSENCMODE: "disable",
            PGCONNECT_TIMEOUT: "10",
        });
    });

    it("decodes a query host exactly once", () => {
        expect(pgEnvironment("postgres:///launch?host=%2Fprivate%2Fpg%2520socket").PGHOST).toBe(
            "/private/pg%20socket",
        );
    });

    it("preserves plus signs and decodes percent escapes only once", () => {
        expect(
            pgEnvironment("postgres://db/launch?sslrootcert=/private/CA+2026%2B%2520.pem")
                .PGSSLROOTCERT,
        ).toBe("/private/CA+2026+%20.pem");
    });

    it.each([
        "?sslpassword=private-secret",
        "?sslrootcert=private-secret&sslrootcert=other",
        "?sslmode=",
        "?sslmode=verify-full&sslmode=disable",
        "?host=",
        "?options=private-secret",
        "?sslrootcert=%00private-secret",
        "?sslrootcert=%ZZprivate-secret",
        "?sslmode=require&%73slmode=require",
        "?user=other",
        "?private-secret=value",
        "?__proto__=private-secret",
    ])("refuses unsupported or ambiguous settings (%s)", (query) => {
        expect(() => pgEnvironment(`postgres://u:private-secret@db/launch${query}`)).toThrow(
            BackupError,
        );
        try {
            pgEnvironment(`postgres://u:private-secret@db/launch${query}`);
        } catch (error) {
            expect(String(error)).not.toContain("private-secret");
        }
    });

    it.each([
        "not a URL private-secret",
        "https://u:private-secret@db/launch",
        "postgres://u:private-secret@db/launch#ignored",
        "postgres://u:private-secret%ZZ@db/launch",
        "postgres://u:private-secret%00@db/launch",
    ])("rejects invalid connection URLs without revealing their contents", (url) => {
        expect(() => pgEnvironment(url)).toThrow(BackupError);
        try {
            pgEnvironment(url);
        } catch (error) {
            expect(String(error)).not.toContain("private-secret");
        }
    });

    it("rejects unsupported backup options before touching the database or filesystem", async () => {
        await expect(
            createBackup({
                db: null as never,
                databaseUrl: "postgres://db/launch?sslpassword=private-secret",
                dataDir: "/unused",
                dest: "/unused",
                version: "test",
            }),
        ).rejects.toThrow(BackupError);
    });
});
