import { describe, expect, it } from "vitest";
import {
    checkBaseImage,
    compactId,
    dockerfile,
    imageTagFor,
    nginxConf,
    TEMPLATE_VERSION,
} from "./template";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("the fixed template", () => {
    it("is exactly this Dockerfile, versioned", () => {
        expect(dockerfile("nginx:1.27-alpine")).toBe(
            [
                "FROM nginx:1.27-alpine",
                `LABEL io.launchpad.template="${TEMPLATE_VERSION}"`,
                "COPY nginx.conf /etc/nginx/conf.d/default.conf",
                "COPY site/ /usr/share/nginx/html/",
                "EXPOSE 80",
                "",
            ].join("\n"),
        );
    });

    it("serves a real 404 unless spa is on, and stamps the deployment id", () => {
        const plain = nginxConf({ spa: false, deploymentId: ID });
        const spa = nginxConf({ spa: true, deploymentId: ID });
        expect(plain).toContain("try_files $uri $uri/ =404;");
        expect(spa).toContain("try_files $uri $uri/ /index.html;");
        expect(plain).toContain(`add_header X-Launchpad-Deployment "${compactId(ID)}" always;`);
        // The two differ in that one line only.
        expect(plain.replace("=404", "/index.html")).toBe(spa);
    });

    it("refuses anything that is not a deployment id or a plain image reference", () => {
        for (const bad of ["", "x", `${ID}; rm -rf /`, `${ID}\n`, `"${ID}"`, ID + "0"]) {
            expect(() => nginxConf({ spa: false, deploymentId: bad })).toThrow();
            expect(() => imageTagFor(bad)).toThrow();
        }
        for (const bad of [
            "",
            "nginx",
            "nginx:latest\nRUN curl evil",
            "nginx:1 && x",
            "NGINX:1",
            "nginx:1.27 AS x",
            "-f:1",
            "a:b@sha256:short",
        ]) {
            expect(() => dockerfile(bad)).toThrow();
            expect(() => checkBaseImage(bad)).toThrow();
        }
        // A tag or a digest is required, so a base image is never "whatever is latest".
        for (const bad of ["reg.example.com:5000/nginx", "nginx", "a/b/c/d/e/f:1"]) {
            expect(() => checkBaseImage(bad), bad).toThrow();
        }
        for (const good of [
            "reg.example.com:5000/library/nginx:1.27",
            `nginx@sha256:${"b".repeat(64)}`,
            "registry.example.com/library/nginx:1.27-alpine",
        ]) {
            expect(checkBaseImage(good)).toBe(good);
        }
        expect(checkBaseImage(`nginx:1.27@sha256:${"a".repeat(64)}`)).toBeTruthy();
    });

    it("tags each deployment's image uniquely and predictably", () => {
        expect(imageTagFor(ID)).toBe("launchpad/site:0f8fad5bd9cb469fa16570867728950e");
    });
});
