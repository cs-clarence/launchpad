{% set shebang = inputs.shebang_executor | default(value="node") -%}
{% if inputs.published %}{% set shebang = "node" %}{% endif -%}
{% if shebang == "node" -%}
#!/usr/bin/env node
{% elif shebang == "bun" -%}
#!/usr/bin/env bun
{% elif shebang == "deno" -%}
#!/usr/bin/env deno
{% endif %}

import { Command } from "@commander-js/extra-typings";
import packageJson from "../../package.json" with { type: "json" };
import { add } from "../add";

const program = new Command();

const { description, name, version } = packageJson;

program.name(name).version(version).description(description);

program
    .command("add")
    .description("Add two numbers.")
    .argument("<a>", "The first number.")
    .argument("<b>", "The second number.")
    .action(async (a, b) => {
        console.log(`result ${add(Number(a), Number(b))}`);
    });

{%- if shebang == "node" %}
program.parseAsync();
{%- elif shebang == "bun" or shebang == "deno" %}
await program.parseAsync();
{% endif %}
