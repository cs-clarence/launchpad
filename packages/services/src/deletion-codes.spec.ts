import { promises as fs } from "node:fs";
import path from "node:path";
import { DELETION_NOTE_CODES, deletionSchema } from "@launchpad-kit/contracts";
import { describe, expect, it } from "vitest";

// The codes a deletion can carry are documented in the contract; this keeps that list
// the same as what the deletion service writes.
describe("deletion note codes", () => {
    it("documents exactly the codes the service writes, each under one status", async () => {
        const source = await fs.readFile(path.join(import.meta.dirname, "deletions.ts"), "utf8");
        const written = new Set<string>();
        for (const m of source.matchAll(/hold\(\s*"([a-z-]+)"/g)) written.add(m[1]!);
        for (const m of source.matchAll(/failure_code:\s*(?:\w+\s*\?\s*)?"([a-z-]+)"/g)) {
            // A deployment's note, not a deletion's.
            if (m[1] !== "preview-deleted") written.add(m[1]!);
        }
        const documented = Object.values(DELETION_NOTE_CODES).flat();
        expect(new Set(documented).size).toBe(documented.length);
        expect([...written].toSorted()).toEqual([...documented].toSorted());
    });

    it("names every code in the published schema description", () => {
        const description = JSON.stringify(
            (deletionSchema.shape.failure as unknown as { meta(): unknown }).meta(),
        );
        for (const code of Object.values(DELETION_NOTE_CODES).flat()) {
            expect(description).toContain(code);
        }
    });
});
