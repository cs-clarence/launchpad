import { useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { apiCall } from "../lib/api";
import {
    afterFailure,
    checkDeployForm,
    fieldsLocked,
    newResume,
    runDeploy,
    withNewFile,
    withNewSpa,
    type Resume,
} from "../lib/deploy-flow";
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
    // Where nothing is deleted automatically a lifetime means nothing, so it is not offered.
    lifecycleEnabled: boolean;
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
    const [locked, setLocked] = useState(false);
    // A new key makes the (uncontrolled) file input forget the file it shows.
    const [fileKey, setFileKey] = useState(0);
    // What a failed run did, so trying again resumes instead of repeating it. Made on the
    // first use, in the browser (keys come from getRandomValues, which plain HTTP pages have).
    const resumeRef = useRef<Resume | null>(null);
    const resume = () => (resumeRef.current ??= newResume());
    const choices = extendChoices(props.maxTtlSeconds).choices;
    const busy = step !== null;
    const frozen = busy || locked;

    function startOver() {
        resumeRef.current = null;
        setLocked(false);
        setFailure(null);
        setProblems([]);
        setFile(null);
        setFileKey((n) => n + 1);
    }

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget;
        const current = resume();
        const found = checkDeployForm({
            needsName: !props.existing && !fieldsLocked(current),
            name,
            file: file && { name: file.name, size: file.size },
            maxBytes: props.maxUploadBytes,
        });
        if (!props.existing && !fieldsLocked(current) && !projectId)
            found.push("Choose a project.");
        setProblems(found);
        setFailure(null);
        if (found.length > 0 || !file) return;
        const result = await runDeploy({
            call: (method, path, options) => apiCall(method, path, options),
            organizationId: props.organizationId,
            file,
            spa,
            resume: current,
            previewId: props.existing?.id,
            create: props.existing ? undefined : { projectId, slug: name, ttl: ttl || undefined },
            onStep: setStep,
        });
        setStep(null);
        if (!result.ok) {
            afterFailure(current, result);
            setLocked(fieldsLocked(current));
            setFailure(
                result.step === "upload" && result.status === null
                    ? `${result.message} Also check that the chosen file has not changed on disk.`
                    : result.message,
            );
            // Another deployment started elsewhere: show it, rather than keep asking.
            if (props.existing && result.status === 409) await router.invalidate({ sync: true });
            return;
        }
        resumeRef.current = null;
        setLocked(false);
        if (props.existing) {
            // Already on the preview's page: look again, and it follows the new deployment.
            form.reset();
            setFile(null);
            setSpa(false);
            setFileKey((n) => n + 1);
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
                            disabled={frozen}
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
                            disabled={frozen}
                            onChange={(event) => setName(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={40}
                        />
                    </label>
                    {props.lifecycleEnabled ? (
                        <label className="block">
                            Lives for{" "}
                            <select
                                className="select inline-block w-auto"
                                value={ttl}
                                disabled={frozen}
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
                    ) : null}
                </>
            ) : null}
            <label className="block">
                Built site (.tar.gz){" "}
                <input
                    key={fileKey}
                    type="file"
                    accept=".tar.gz,.tgz,application/gzip"
                    disabled={busy}
                    onChange={(event) => {
                        setFile(event.target.files?.[0] ?? null);
                        withNewFile(resume());
                    }}
                />
            </label>
            <label className="block">
                <input
                    type="checkbox"
                    checked={spa}
                    disabled={busy}
                    onChange={(event) => {
                        setSpa(event.target.checked);
                        withNewSpa(resume());
                    }}
                />{" "}
                Single-page app (serve index.html for unknown paths)
            </label>
            <button type="submit" className="btn preset-filled" disabled={busy}>
                Deploy
            </button>{" "}
            {failure || locked ? (
                <button
                    type="button"
                    className="btn preset-tonal"
                    disabled={busy}
                    onClick={startOver}
                >
                    Start over
                </button>
            ) : null}
            <p role="status">{step ? STEP_TEXT[step] : ""}</p>
            {problems.length > 0 ? (
                <ul role="alert" className="list-disc pl-6">
                    {problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                    ))}
                </ul>
            ) : null}
            {locked && !resumeRef.current?.previewId ? (
                <p role="status">
                    The preview may already have been created, so its details are locked to match
                    the retry. Use Start over to change them.
                </p>
            ) : null}
            {failure ? (
                <p role="alert">
                    {failure}
                    {resumeRef.current?.previewId && !props.existing
                        ? " The preview was created; deploying again will use it."
                        : ""}
                </p>
            ) : null}
            <p className="text-sm">
                Make the archive from your built directory, for example{" "}
                <code>tar -czf site.tar.gz -C dist .</code> (on macOS, set{" "}
                <code>COPYFILE_DISABLE=1</code> first). An archive that contains links or
                secret-looking files (<code>.env</code>, <code>.git</code>, private keys) is refused
                as a whole.
            </p>
        </form>
    );
}
