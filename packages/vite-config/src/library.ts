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

// Modules that exist at run time and must never be bundled. `bun` is listed
// explicitly: `builtinModules` includes it only when Vite itself runs under Bun, so
// a build under Node (as in CI) would otherwise fail to resolve `import "bun"`.
export function isExternal(
    id: string,
    dependencies: string[],
    externalizeDeps = true,
    builtins: readonly string[] = builtinModules,
): boolean {
    return (
        id.startsWith("node:") ||
        id.startsWith("bun:") ||
        id === "bun" ||
        builtins.includes(id) ||
        (externalizeDeps &&
            dependencies.some((dependency) => id === dependency || id.startsWith(`${dependency}/`)))
    );
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
                    external: (id: string) => isExternal(id, dependencies, options.externalizeDeps),
                },
            },
        },
        options.overrides ?? {},
    );
}
