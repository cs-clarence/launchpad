import { mergeConfig, type UserWorkspaceConfig } from "vitest/config";
import baseConfig from "./vite.config.ts";
import integrationTestConfig from "@launchpad-kit/vitest-config/integration";

// Only the live suite: it needs a disposable Dokku and Docker, and is never part of
// `test` or CI. See src/__tests__/live.spec.ts for what it needs and what it touches.
export default mergeConfig(mergeConfig(baseConfig, integrationTestConfig), {
    test: {
        testTimeout: 10 * 60_000,
        hookTimeout: 5 * 60_000,
        include: ["./src/__tests__/live.spec.ts"],
    },
} satisfies UserWorkspaceConfig);
