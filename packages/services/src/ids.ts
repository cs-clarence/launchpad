import { randomInt } from "node:crypto";

// Leaf helpers shared by previews and the hostname templates: no database, no framework, so a
// module that needs only these does not load the services around them.
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const PREVIEW_DOMAIN_PATTERN =
    /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// The immutable model's apps domain: the legacy 200-character cap does not apply. Only the DNS
// limit does, and the hostname template checks the full worst-case hostname against 253.
export const APPS_DOMAIN_PATTERN =
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function opaqueId(length: number): string {
    let id = "";
    for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    return id;
}

export const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
