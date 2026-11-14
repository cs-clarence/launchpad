import { builtinModules } from "node:module";
import { mergeConfig, type UserConfig } from "vite";
import dts from "unplugin-dts/vite";

interface ConfigOptions {
    package?: {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
    };
    overrides?: UserConfig;
    generateTypes?: boolean;
    externalizeDeps?: boolean;
}

export function createConfig(options: ConfigOptions = {}): UserConfig {
    const dependencies = Object.keys({
        ...options.package?.dependencies,
        ...options.package?.peerDependencies,
    });
    return mergeConfig(
        {
            plugins:
                options.generateTypes === false
                    ? []
                    : [dts({ tsconfigPath: "./tsconfig.types.json" })],
            build: {
                rolldownOptions: {
                    external: (id: string) =>
                        id.startsWith("node:") ||
                        id.startsWith("bun:") ||
                        builtinModules.includes(id) ||
                        (options.externalizeDeps !== false &&
                            dependencies.some(
                                (dependency) =>
                                    id === dependency || id.startsWith(`${dependency}/`),
                            )),
                },
            },
        },
        options.overrides ?? {},
    );
}
