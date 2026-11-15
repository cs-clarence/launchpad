import { defineProject } from "vitest/config";

export default defineProject({
    test: {
        environment: "node",
        include: ["src/**/__tests__/**/*.spec.ts"],
        // Creating a database is part of every file's setup, and many projects do it at once
        // against one small server: the default 10 s is too tight when the machine is busy.
        hookTimeout: 60_000,
    },
});
