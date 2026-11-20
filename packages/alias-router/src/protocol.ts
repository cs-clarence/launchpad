import { z } from "zod";

export type RouterErrorCode = "invalid" | "unauthorized" | "conflict" | "unavailable";
const MESSAGES: Record<RouterErrorCode, string> = {
    invalid: "Invalid router input.",
    unauthorized: "Router authority is not valid.",
    conflict: "Router state conflicts with this operation.",
    unavailable: "Router state is unavailable; operator intervention is required.",
};

// Never attach raw validation/SQLite errors: they may contain supplied secrets or state.
export class RouterError extends Error {
    constructor(readonly code: RouterErrorCode) {
        super(MESSAGES[code]);
        this.name = "RouterError";
    }
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const token = z.string().regex(/^[0-9a-f]{64}$/);
const label = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;
export const hostnameSchema = z
    .string()
    .max(253)
    .refine((value) => {
        const labels = value.split(".");
        if (
            labels.length < 2 ||
            !labels.every((part) => label.test(part)) ||
            !/[a-z]/.test(labels.at(-1)!)
        ) {
            return false;
        }
        // The data plane reads the Host through a URL: a name the HTTP URL parser would rewrite
        // (`sites.0x1` is an IPv4 number) could be acknowledged here and never served.
        try {
            return new URL(`http://${value}`).hostname === value;
        } catch {
            return false;
        }
    });
export const MAX_GENERATION = "9223372036854775807";
const generation = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    // Zod still runs refinements after a failed regex, and BigInt() throws on non-digits.
    .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt(MAX_GENERATION));

export const authoritySchema = z.strictObject({ epoch: uuid, token });
export const authenticationSchema = authoritySchema.extend({ instanceId: uuid });
export const storeOptionsSchema = z.strictObject({ instanceId: uuid, appsDomain: hostnameSchema });
export const deploymentSchema = z.strictObject({ deploymentId: uuid, hostname: hostnameSchema });
export const routeWriteSchema = z.strictObject({
    aliasId: uuid,
    hostname: hostnameSchema,
    operationId: uuid,
    generation,
    targetDeploymentId: uuid.nullable(),
});
export const pageSchema = z.strictObject({
    after: hostnameSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
});

export type AuthorityInput = z.infer<typeof authoritySchema>;
export type StoreOptions = z.infer<typeof storeOptionsSchema>;
export type DeploymentTarget = z.infer<typeof deploymentSchema>;
export type RouteWrite = z.infer<typeof routeWriteSchema>;
const routeRecordSchema = routeWriteSchema.omit({ targetDeploymentId: true }).extend({
    target: deploymentSchema.nullable(),
});
export const routeObservationSchema = z.strictObject({
    instanceId: uuid,
    epoch: uuid,
    route: routeRecordSchema.nullable(),
});
export type RouteRecord = z.infer<typeof routeRecordSchema>;
export type RouteObservation = z.infer<typeof routeObservationSchema>;
export interface RoutePage {
    instanceId: string;
    epoch: string;
    routes: RouteRecord[];
    nextCursor: string | null;
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new RouterError("invalid");
    return result.data;
}

export function admittedHostname(hostname: string, appsDomain: string): boolean {
    const suffix = `.${appsDomain}`;
    return hostname.endsWith(suffix) && label.test(hostname.slice(0, -suffix.length));
}
