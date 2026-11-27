{% set shebang = inputs.shebang_executor | default(value="node") -%}
{% if inputs.published %}{% set shebang = "node" %}{% endif -%}
{
    "name": "{{ vars.full_package_name }}",
    "type": "module",
    "description": "{{ inputs.package_description }}",
    "version": "{{ inputs.package_version }}",
    "private": {{ not inputs.published }},
    "scripts": {
        "build": "vite build",
        "check:types": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json"
        {% if inputs.unit_test | default(value=false) %}
        , "test:unit": "vitest run --config vitest.config.unit.ts"
        {% endif %}
        {% if inputs.integration_test | default(value=false) %}
        , "test:integration": "vitest run --config vitest.config.integration.ts"
        {% endif %}
        {% if inputs.package_type == 'service-tests' %}
        , "test:service": "vitest run --config vitest.config.service.ts"
        {% elif inputs.package_type == 'e2e-tests' %}
        , "test:e2e": "vitest run --config vitest.config.e2e.ts"
        {% endif %}
    },
    {% if inputs.package_type == 'script' %}
    "bin": {
        "{% if inputs.bin_name %}{{ inputs.bin_name }}{% else %}{{ inputs.package_name }}{% endif %}": "./dist/cli.mjs"
    },
    {% endif %}
    {% if inputs.package_type == 'lib' or inputs.package_type == 'ui-lib' or (inputs.package_type == 'script' and inputs.script_can_be_used_as_lib) %}
    "exports": {
        ".": {
            "types": "./src/index.ts",
            "import": {
                "development": "./src/index.ts",
                "default": "./src/index.ts"
            },
            "require": {
                "development": "./src/index.ts",
                "default": "./src/index.ts"
            }
        }
    },
    {% endif %}
    {% if inputs.published %}
    "publishConfig": {
        "access": "{{ inputs.publish_access }}"
    },
    {% endif %}
    "dependencies": {
        {% if inputs.package_type == "script" %}
        "commander": "catalog:",
        "@commander-js/extra-typings": "catalog:"
        {% endif %}
    },
    "devDependencies": {
        "@{{ vars.scope_name }}/tsconfig": "workspace:^",
        "@{{ vars.scope_name }}/vite-config": "workspace:^",
        "@{{ vars.scope_name }}/vitest-config": "workspace:^",
        "vite": "catalog:",
        "vitest": "catalog:",
        {% if inputs.package_type == 'script' %}
        "@types/node": "catalog:",
            {% if shebang == 'bun' %}
        "@types/bun": "catalog:",
            {% elif shebang == 'deno' %}
        "@types/deno": "catalog:",
            {% endif %}
        {% endif %}
        {% if inputs.package_type == 'ui-lib' and inputs.component_test %}
        "@vitest/browser-playwright": "catalog:",
        "playwright": "catalog:",
        {% endif %}
        "typescript": "catalog:"
    }
}
