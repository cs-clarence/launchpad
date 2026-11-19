import { randomInt } from "node:crypto";

// Leaf helpers shared by previews and the hostname templates: no database, no framework, so a
// module that needs only these does not load the services around them.
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const PREVIEW_DOMAIN_PATTERN =
    /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function opaqueId(length: number): string {
    let id = "";
    for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    return id;
}
