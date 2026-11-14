import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { gzipSync, createGzip } from "node:zlib";

// Hand-built tar archives for tests, including hostile ones a normal tool refuses to
// make. Test support only: never exported from the package.

export interface FixtureEntry {
    name: string;
    type?: "file" | "dir" | "symlink" | "hardlink" | "char" | "block" | "fifo" | "sparse";
    content?: Buffer | string;
    link?: string;
    // Carry the name in a pax extended header, so it can exceed the ustar limit.
    pax?: boolean;
}

const TYPE_FLAG = {
    file: "0",
    dir: "5",
    symlink: "2",
    hardlink: "1",
    char: "3",
    block: "4",
    fifo: "6",
    sparse: "S",
} as const;

function octal(value: number, width: number): string {
    return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(entry: FixtureEntry, size: number): Buffer {
    const block = Buffer.alloc(512);
    const flag = TYPE_FLAG[entry.type ?? "file"];
    const name = Buffer.from(entry.name);
    // ustar: names longer than 100 bytes continue in the 155-byte prefix field.
    let prefix = Buffer.alloc(0);
    let base = name;
    if (name.length > 100) {
        const cut = entry.name.lastIndexOf("/", 100 + 155);
        const split = entry.name.slice(0, cut);
        const rest = entry.name.slice(cut + 1);
        if (cut > 0 && Buffer.byteLength(rest) <= 100 && Buffer.byteLength(split) <= 155) {
            prefix = Buffer.from(split);
            base = Buffer.from(rest);
        } else {
            base = name.subarray(0, 100);
        }
    }
    base.copy(block, 0);
    block.write(octal(entry.type === "dir" ? 0o755 : 0o644, 8), 100);
    block.write(octal(0, 8), 108);
    block.write(octal(0, 8), 116);
    block.write(octal(size, 12), 124);
    block.write(octal(0, 12), 136);
    block.write("        ", 148);
    block.write(flag, 156);
    if (entry.link) block.write(entry.link, 157);
    block.write("ustar\0", 257);
    block.write("00", 263);
    prefix.copy(block, 345);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return block;
}

function body(content: Buffer): Buffer {
    return Buffer.concat([content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

// One pax record is "<length> path=<value>\n", where the length counts itself.
function paxRecord(key: string, value: string): Buffer {
    const rest = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(rest);
    length += String(length).length;
    if (String(length).length !== String(length - String(length).length).length) length += 1;
    return Buffer.from(`${length}${rest}`);
}

export function tarBuffer(entries: FixtureEntry[], options: { terminate?: boolean } = {}): Buffer {
    const parts: Buffer[] = [];
    for (const entry of entries) {
        if (entry.pax) {
            const record = paxRecord("path", entry.name);
            const meta = Buffer.alloc(512);
            meta.write("PaxHeader/x", 0);
            meta.write(octal(0o644, 8), 100);
            meta.write(octal(0, 8), 108);
            meta.write(octal(0, 8), 116);
            meta.write(octal(record.length, 12), 124);
            meta.write(octal(0, 12), 136);
            meta.write("        ", 148);
            meta.write("x", 156);
            meta.write("ustar\0", 257);
            meta.write("00", 263);
            let sum = 0;
            for (const byte of meta) sum += byte;
            meta.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
            parts.push(meta, body(record));
        }
        const content = Buffer.from(entry.content ?? "");
        const withBody = (entry.type ?? "file") === "file";
        parts.push(header(entry, withBody ? content.length : 0));
        if (withBody) parts.push(body(content));
    }
    if (options.terminate !== false) parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

export const tarGz = (entries: FixtureEntry[]) => gzipSync(tarBuffer(entries));

// A valid site: index.html plus a nested asset.
export const SITE: FixtureEntry[] = [
    { name: "index.html", content: "<!doctype html><title>x</title>" },
    { name: "assets/", type: "dir" },
    { name: "assets/app.js", content: "console.log(1)" },
];

// Streams `size` zero bytes as one file, so an archive that expands far beyond its
// compressed size can be made without holding it in memory.
export async function writeBombTarGz(
    path: string,
    size: number,
    before: FixtureEntry[] = [{ name: "index.html", content: "x" }],
): Promise<void> {
    const out = createWriteStream(path);
    const gzip = createGzip();
    gzip.pipe(out);
    const write = async (chunk: Buffer) => {
        if (!gzip.write(chunk)) await once(gzip, "drain");
    };
    for (const entry of before) await write(tarBuffer([entry], { terminate: false }));
    await write(header({ name: "big.bin" }, size));
    const chunk = Buffer.alloc(64 * 1024);
    for (let left = size; left > 0; left -= chunk.length) {
        await write(left >= chunk.length ? chunk : chunk.subarray(0, left));
    }
    await write(Buffer.alloc((512 - (size % 512)) % 512));
    await write(Buffer.alloc(1024));
    gzip.end();
    await once(out, "close");
}
