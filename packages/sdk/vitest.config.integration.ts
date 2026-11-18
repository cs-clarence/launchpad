import { mergeConfig, type UserWorkspaceConfig } from "vitest/config";
import baseConfig from "./vite.config.ts";
import integrationTestConfig from "@launchpad-kit/vitest-config/integration";

export default mergeConfig(mergeConfig(baseConfig, integrationTestConfig), {
    test: {
        testTimeout: 10_000,
        include: ["./src/**/__tests__/**/*.spec.ts"],
    },
} satisfies UserWorkspaceConfig);
