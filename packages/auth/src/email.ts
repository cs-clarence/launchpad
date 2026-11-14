import { z } from "zod";
import { InvalidSetupInputError } from "./errors";

// Better Auth validates sign-in addresses with zod's `email()`. Provisioned accounts
// must pass the same rule, or the account could be created but never signed into.
export function normalizeEmail(input: string): string {
    const email = input.trim().toLowerCase();
    if (!z.email().safeParse(email).success) {
        throw new InvalidSetupInputError("A valid email address is required.");
    }
    return email;
}
