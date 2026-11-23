import { randomBytes } from "node:crypto";
import { fixtureDocker } from "./docker";
import { planFixture } from "./fixture";

// Render only: the arbitrary fixture ports are not bound or reserved.
const plan = planFixture(randomBytes(12).toString("hex"), [42180, 42222, 42181, 42443, 42182], 0);
await fixtureDocker(plan).validate();
console.log("Disposable Compose fixture rendered and validated; nothing was started.");
