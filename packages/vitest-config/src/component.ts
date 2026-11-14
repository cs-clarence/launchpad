import { defineProject } from "vitest/config";

export default defineProject({
    test: { include: ["src/**/*.component.spec.tsx"] },
});
