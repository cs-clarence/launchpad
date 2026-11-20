import { mergeConfig, type UserWorkspaceConfig } from "vitest/config";
import baseConfig from "./vite.config.ts";
import integrationTestConfig from "@launchpad-kit/vitest-config/integration";

export default mergeConfig(mergeConfig(baseConfig, integrationTestConfig), {
    test: {
        testTimeout: 30_000,
        include: [
            "./src/__tests__/deployment-worker.spec.ts",
            "./src/__tests__/acceptance.spec.ts",
            "./src/__tests__/promotion-loopback.spec.ts",
        ],
        exclude: ["./src/__tests__/live.spec.ts"],
    },
} satisfies UserWorkspaceConfig);
