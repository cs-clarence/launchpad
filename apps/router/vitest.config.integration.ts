import { mergeConfig, type UserWorkspaceConfig } from "vitest/config";
import baseConfig from "./vite.config.ts";
import integrationTestConfig from "@launchpad-kit/vitest-config/integration";

export default mergeConfig(mergeConfig(baseConfig, integrationTestConfig), {
    test: {
        testTimeout: 20_000,
        include: ["./src/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    },
} satisfies UserWorkspaceConfig);
