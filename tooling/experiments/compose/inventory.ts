import { NAME, type Result } from "../acceptance/harness";

export type Deployment = { id: string; app: string; image: string; state: string };

export function readInventory(out: string, previous: Deployment[]): Deployment[] {
    const found = (out ? out.split("\n") : []).map((row) => {
        const [id = "", app = "", state = "", extra] = row.split(" ");
        const image = `launchpad/site:${id.replaceAll("-", "")}`;
        if (
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
            !NAME.app.test(app) ||
            !NAME.tag.test(image) ||
            !state ||
            extra !== undefined
        )
            throw new Error("Unexpected name in fixture deployment inventory.");
        return { id, app, image, state };
    });
    if (previous.some((past) => !found.some((row) => row.id === past.id && row.app === past.app)))
        throw new Error("The fixture database no longer contains its recorded inventory.");
    return found;
}

export function fixtureDeploymentGone(
    deployment: Deployment,
    app: Result,
    containers: Result,
    images: Result,
) {
    return (
        deployment.state === "deleted" &&
        containers.code === 0 &&
        !containers.out &&
        images.code === 0 &&
        !images.out &&
        [1, 20].includes(app.code) &&
        `${app.out}\n${app.err}`.includes(`App ${deployment.app} does not exist`)
    );
}
