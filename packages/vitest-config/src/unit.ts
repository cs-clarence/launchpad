import { defineProject } from "vitest/config";

export default defineProject({
    test: {
        environment: "node",
        include: ["src/**/*.spec.ts"],
        exclude: ["src/**/__tests__/**", "src/**/*.component.spec.ts"],
        testTimeout: 5000,
    },
});
