import { describe, expect, it } from "vitest";
import { can, canAssignRole, ORGANIZATION_ROLES, type OrganizationAction } from "./authorization";
import { getControllerInfo } from "./index";

describe("organization authorization matrix", () => {
    const table: Record<string, OrganizationAction[]> = {
        viewer: ["organization:read", "member:read", "project:read", "preview:read"],
        deployer: [
            "organization:read",
            "member:read",
            "project:read",
            "preview:read",
            "project:create",
            "preview:create",
            "preview:deploy",
            "preview:delete",
        ],
        admin: [
            "organization:read",
            "member:read",
            "project:read",
            "preview:read",
            "project:create",
            "preview:create",
            "preview:deploy",
            "preview:delete",
            "member:manage",
            "project:delete",
            "apikey:manage",
        ],
        owner: [
            "organization:read",
            "member:read",
            "project:read",
            "preview:read",
            "project:create",
            "preview:create",
            "preview:deploy",
            "preview:delete",
            "member:manage",
            "project:delete",
            "apikey:manage",
            "organization:delete",
        ],
    };
    const all = new Set(Object.values(table).flat());

    it("grants exactly the documented actions to each role", () => {
        for (const role of ORGANIZATION_ROLES) {
            for (const action of all) {
                expect(can(role, action), `${role} ${action}`).toBe(table[role]!.includes(action));
            }
        }
    });

    it("lets owners assign any role and admins only lower roles", () => {
        for (const target of ORGANIZATION_ROLES) {
            expect(canAssignRole("owner", target)).toBe(true);
        }
        expect(canAssignRole("admin", "viewer")).toBe(true);
        expect(canAssignRole("admin", "deployer")).toBe(true);
        expect(canAssignRole("admin", "admin")).toBe(false);
        expect(canAssignRole("admin", "owner")).toBe(false);
        expect(canAssignRole("deployer", "viewer")).toBe(false);
        expect(canAssignRole("viewer", "viewer")).toBe(false);
    });
});

describe("controller info", () => {
    it("reports scaffold metadata", () => {
        expect(getControllerInfo()).toEqual({ name: "launchpad", phase: "bootstrap" });
    });
});
