import { expect, it } from "vitest";
import { getControllerInfo } from "./index";

it("provides controller metadata without infrastructure or HTTP", () => {
    expect(getControllerInfo()).toEqual({
        name: "launchpad",
        phase: "bootstrap",
    });
});
