{% if inputs.package_type == "lib" or inputs.package_type == "ui-lib" %}
import { createConfig } from "@{{ vars.scope_name }}/vite-config/library";
{% elif inputs.package_type == "script" %}
import { createConfig } from "@{{ vars.scope_name }}/vite-config/script";
{% elif inputs.package_type == "app" %}
import { createConfig } from "@{{ vars.scope_name }}/vite-config/app";
{% elif inputs.package_type == "e2e-tests" or inputs.package_type == "service-tests" %}
import { createConfig } from "@{{ vars.scope_name }}/vite-config/test";
{% endif %}
{% set exclude_deps_from_bundle = inputs.package_type == "lib" or inputs.package_type == "ui-lib" or (inputs.package_type == "script" and (inputs.script_can_be_used_as_lib or inputs.published)) %}
import packageJson from "./package.json" with { type: "json" };

export default createConfig({
    package: packageJson,
    {% if inputs.package_type == "script" %}
    generateTypes: {{ inputs.script_can_be_used_as_lib }},
    externalizeDeps: {{ exclude_deps_from_bundle }},
    {% endif %}
    overrides: {
        build: {
            lib: {
                entry: {
                    {% if inputs.package_type == "script" %}
                    "cli": "src/cli/index.ts",
                    {% endif %}
                    {% if inputs.package_type != "script" or inputs.script_can_be_used_as_lib %}
                    "index": "src/index.ts",
                    {% endif %}
                },
                formats: ["es"],
                fileName: (format, entryName) =>
                    `${entryName || "{{ inputs.package_name }}"}.${format === "cjs" ? "cjs" : "mjs"}`,
                name: "{{ inputs.package_name | pascal_case }}",
            },
        },
    },
});
