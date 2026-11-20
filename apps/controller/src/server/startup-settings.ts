import { assertCurrentSettings } from "@launchpad-kit/services";
import { definePlugin } from "nitro";

// Runs when the server initializes, before it accepts a request: a removed setting stops the
// process here instead of failing every request later.
export default definePlugin(() => {
    assertCurrentSettings(process.env);
});
