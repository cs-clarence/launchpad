import { useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { apiCall } from "../lib/api";
import { checkDeployForm, newResume, runDeploy, type Resume } from "../lib/deploy-flow";
import { extendChoices } from "../lib/previews";

const STEP_TEXT = {
    create: "Creating the preview…",
    upload: "Uploading the site…",
    deploy: "Starting the deployment…",
} as const;

// Deploys a built site (a .tar.gz of the built directory) to a new preview, or a new version
// to the one it is on. The browser's checks only save a round trip; the server decides.
export function DeployPanel(props: {
    organizationId: string;
    projects: { id: string; name: string }[];
    maxUploadBytes: number;
    maxTtlSeconds: number;
    // Present: deploy a new version to this preview instead of making one.
    existing?: { id: string };
}) {
    const navigate = useNavigate();
    const router = useRouter();
    const [projectId, setProjectId] = useState(props.projects[0]?.id ?? "");
    const [name, setName] = useState("");
    const [ttl, setTtl] = useState("");
    const [spa, setSpa] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [step, setStep] = useState<keyof typeof STEP_TEXT | null>(null);
    const [problems, setProblems] = useState<string[]>([]);
    const [failure, setFailure] = useState<string | null>(null);
    // What a failed run did, so trying again resumes instead of repeating it.
    const resume = useRef<Resume>(newResume());
    const choices = extendChoices(props.maxTtlSeconds).choices;
    const busy = step !== null;

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        const found = checkDeployForm({
            needsName: !props.existing && !resume.current.previewId,
            name,
            file: file && { name: file.name, size: file.size },
            maxBytes: props.maxUploadBytes,
        });
        if (!props.existing && !resume.current.previewId && !projectId) {
            found.push("Choose a project.");
        }
        setProblems(found);
        setFailure(null);
        if (found.length > 0 || !file) return;
        const result = await runDeploy({
            call: (method, path, options) => apiCall(method, path, options),
            organizationId: props.organizationId,
            file,
            spa,
            resume: resume.current,
            previewId: props.existing?.id,
            create: props.existing ? undefined : { projectId, slug: name, ttl: ttl || undefined },
            onStep: setStep,
        });
        setStep(null);
        if (!result.ok) {
            setFailure(result.message);
            return;
        }
        resume.current = newResume();
        if (props.existing) {
            // Already on the preview's page: look again, and it follows the new deployment.
            (event.target as HTMLFormElement).reset();
            setFile(null);
            await router.invalidate({ sync: true });
            return;
        }
        await navigate({
            to: "/orgs/$orgId/previews/$previewId",
            params: { orgId: props.organizationId, previewId: result.previewId },
        });
    }

    return (
        <form className="space-y-3" onSubmit={submit} aria-busy={busy}>
            <h2 className="h4">{props.existing ? "Deploy a new version" : "Deploy a site"}</h2>
            {!props.existing ? (
                <>
                    <label className="block">
                        Project{" "}
                        <select
                            className="select inline-block w-auto"
                            value={projectId}
                            disabled={busy || resume.current.previewId !== undefined}
                            onChange={(event) => setProjectId(event.target.value)}
                        >
                            {props.projects.map((project) => (
                                <option key={project.id} value={project.id}>
                                    {project.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        Preview name{" "}
                        <input
                            className="input inline-block w-auto"
                            value={name}
                            disabled={busy || resume.current.previewId !== undefined}
                            onChange={(event) => setName(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={40}
                        />
                    </label>
                    <label className="block">
                        Lives for{" "}
                        <select
                            className="select inline-block w-auto"
                            value={ttl}
                            disabled={busy || resume.current.previewId !== undefined}
                            onChange={(event) => setTtl(event.target.value)}
                        >
                            <option value="">the server's default</option>
                            {choices.map((choice) => (
                                <option key={choice} value={choice}>
                                    {choice}
                                </option>
                            ))}
                        </select>
                    </label>
                </>
            ) : null}
            <label className="block">
                Built site (.tar.gz){" "}
                <input
                    type="file"
                    accept=".tar.gz,.tgz,application/gzip"
                    disabled={busy}
                    onChange={(event) => {
                        setFile(event.target.files?.[0] ?? null);
                        // A different file is a different upload and a different deployment.
                        resume.current.artifactId = undefined;
                        resume.current.deployKey = newResume().deployKey;
                    }}
                />
            </label>
            <label className="block">
                <input
                    type="checkbox"
                    checked={spa}
                    disabled={busy}
                    onChange={(event) => setSpa(event.target.checked)}
                />{" "}
                Single-page app (serve index.html for unknown paths)
            </label>
            <button type="submit" className="btn preset-filled" disabled={busy}>
                {busy ? STEP_TEXT[step] : "Deploy"}
            </button>
            {problems.length > 0 ? (
                <ul role="alert" className="list-disc pl-6">
                    {problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                    ))}
                </ul>
            ) : null}
            {failure ? (
                <p role="alert">
                    {failure}
                    {resume.current.previewId && !props.existing
                        ? " The preview was created; deploying again will use it."
                        : ""}
                </p>
            ) : null}
            <p className="text-sm">
                Make the archive from your built directory, for example{" "}
                <code>tar -czf site.tar.gz -C dist .</code>. Links and files that look like secrets
                are refused by the server.
            </p>
        </form>
    );
}
