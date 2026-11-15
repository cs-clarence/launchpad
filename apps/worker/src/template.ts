// The only image Launchpad builds. The Dockerfile and the web server configuration are
// fixed here and versioned; the only inputs are the deployment's own id, the SPA
// switch and a validated base image reference. Nothing from an archive, a request or
// a display name is ever interpolated: there is no user Dockerfile and no build command.

export const TEMPLATE_VERSION = "1";
export const DEFAULT_BASE_IMAGE = "nginx:1.27-alpine";

// [registry[:port]/]path[:tag][@sha256:digest]; a tag or a digest is required, so a base
// image is never "whatever latest is". A digest pin is what makes a build repeatable.
const BASE_IMAGE =
    /^(?:[a-z0-9][a-z0-9.-]{0,60}(?::[0-9]{1,5})?\/)?[a-z0-9][a-z0-9._-]{0,60}(?:\/[a-z0-9][a-z0-9._-]{0,60}){0,3}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
const HAS_REFERENCE = /(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/;
const DEPLOYMENT_ID = /^[0-9a-f]{32}$/;

export function checkBaseImage(value: string): string {
    if (!BASE_IMAGE.test(value) || !HAS_REFERENCE.test(value))
        throw new Error("The base image reference is not valid.");
    return value;
}

// A deployment id without dashes: the form that is safe in an image tag and a header.
export function compactId(uuid: string): string {
    const id = uuid.replaceAll("-", "").toLowerCase();
    if (!DEPLOYMENT_ID.test(id)) throw new Error("Not a deployment id.");
    return id;
}

export function dockerfile(baseImage: string): string {
    return [
        `FROM ${checkBaseImage(baseImage)}`,
        `LABEL io.launchpad.template="${TEMPLATE_VERSION}"`,
        "COPY nginx.conf /etc/nginx/conf.d/default.conf",
        "COPY site/ /usr/share/nginx/html/",
        "EXPOSE 80",
        "",
    ].join("\n");
}

// `spa` makes unknown paths serve index.html with 200; otherwise they are a real 404.
// The deployment id header lets the readiness probe prove it reached this image and
// not an older one.
export function nginxConf(options: { spa: boolean; deploymentId: string }): string {
    const id = compactId(options.deploymentId);
    return [
        "server {",
        "    listen 80;",
        "    server_name _;",
        "    server_tokens off;",
        "    root /usr/share/nginx/html;",
        "    index index.html;",
        `    add_header X-Launchpad-Deployment "${id}" always;`,
        '    add_header X-Content-Type-Options "nosniff" always;',
        "    location / {",
        `        try_files $uri $uri/ ${options.spa ? "/index.html" : "=404"};`,
        "    }",
        "}",
        "",
    ].join("\n");
}

export function imageTagFor(deploymentId: string): string {
    return `launchpad/site:${compactId(deploymentId)}`;
}
