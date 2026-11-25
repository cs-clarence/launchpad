import type { z } from "zod";

// Loose: a newer controller may add fields without breaking an older client.
export const loose = <S extends z.ZodObject>(schema: S) =>
    schema.loose() as unknown as z.ZodType<z.infer<S>>;
