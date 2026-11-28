import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
    existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs the workflow's real step against a fake `gh`, so the invariants that make it safe are
// executed, not merely matched as text: the live main tip decides, and close -> delete -> dispatch
// happens in that order, only for stale release PRs in this repository.
const file = readFileSync(
    path.join(import.meta.dirname, "..", ".github/workflows/release-pr-sync.yaml"),
    "utf8",
);
const wf = Bun.YAML.parse(file) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<
        string,
        {
            if?: string;
            permissions?: Record<string, string>;
            steps: { uses?: string; run?: string }[];
        }
    >;
};
const job = wf.jobs.regenerate!;
const script = job.steps.find((step) => step.run?.includes("gh api --paginate"))?.run ?? "";

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
dir="\${GH_FAKE_DIR:?}"
echo "$*" >> "$dir/calls.log"
case "\${1:-} \${2:-}" in
  "api --paginate")
    if [ -f "$dir/list-fails" ]; then
      echo "HTTP 500: Internal Server Error" >&2
      exit 1
    fi
    case "\${3:-}" in
      *matching-refs*)
        if [ -f "$dir/markers-fail" ]; then
          echo "HTTP 500: Internal Server Error" >&2
          exit 1
        fi
        cat "$dir/retry-refs" 2>/dev/null || true
        ;;
      *)
        cat "$dir/prs"
        if [ -f "$dir/paginate-fails" ]; then
          echo "HTTP 500: Internal Server Error on a later page" >&2
          exit 1
        fi
        ;;
    esac
    ;;
  "pr list")
    head=""
    expr=""
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --head) head="$2"; shift 2 ;;
        --jq) expr="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    version="\${head#release/}"
    if [ -f "$dir/closed-raw/$version" ]; then
      jq -r "$expr" "$dir/closed-raw/$version"
    elif [ -f "$dir/closed/$version" ]; then
      cat "$dir/closed/$version"
    else
      echo none
    fi
    ;;
  "pr close")
    number="\${3:?}"
    if [ -f "$dir/already-closed/$number" ]; then
      echo "Pull request #$number is already closed"
      exit 0
    fi
    if [ -f "$dir/close-fails/$number" ]; then
      echo "GraphQL: Could not resolve to a PullRequest with the number of $number." >&2
      exit 1
    fi
    echo "close $number" >> "$dir/actions.log"
    ;;
  "pr view")
    number="\${3:?}"
    if [ -f "$dir/state/$number" ]; then
      state=$(head -n 1 "$dir/state/$number")
      tail -n +2 "$dir/state/$number" > "$dir/state/$number.next"
      mv "$dir/state/$number.next" "$dir/state/$number"
      echo "$state"
    else
      echo OPEN
    fi
    ;;
  "pr reopen")
    if [ -f "$dir/reopen-fails" ]; then
      echo "HTTP 500: Internal Server Error" >&2
      exit 1
    fi
    echo "reopen \${3:?}" >> "$dir/actions.log"
    ;;
  "workflow run")
    if [ -f "$dir/dispatch-fails" ]; then
      echo "HTTP 500: Internal Server Error" >&2
      exit 1
    fi
    if [ -f "$dir/dispatch-fails-once" ] && [ ! -f "$dir/dispatch-failed-once" ]; then
      touch "$dir/dispatch-failed-once"
      echo "HTTP 500: Internal Server Error" >&2
      exit 1
    fi
    base=""
    channel=""
    shift 3
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-f" ]; then
        case "\${2:-}" in
          base=*) base="\${2#base=}" ;;
          channel=*) channel="\${2#channel=}" ;;
        esac
        shift 2
      else
        shift
      fi
    done
    echo "dispatch $base $channel" >> "$dir/actions.log"
    ;;
  "api -X")
    method="\${3:?}"
    url="\${4:?}"
    if [ "$method" = "PATCH" ]; then
      if [ -f "$dir/tag-create-fails" ]; then
        echo "HTTP 500: Internal Server Error" >&2
        exit 1
      fi
      ref=""
      sha=""
      shift 4
      while [ "$#" -gt 0 ]; do
        case "$1" in
          sha=*) sha="\${1#sha=}" ;;
        esac
        shift
      done
      echo "update-tag \${url##*/git/refs/} $sha" >> "$dir/actions.log"
      exit 0
    fi
    if [ "$method" = "POST" ]; then
      ref=""
      sha=""
      shift 4
      while [ "$#" -gt 0 ]; do
        case "$1" in
          ref=*) ref="\${1#ref=}" ;;
          sha=*) sha="\${1#sha=}" ;;
        esac
        shift
      done
      if [ -f "$dir/create-ref-fails" ] && [[ "$ref" == refs/heads/* ]]; then
        echo "HTTP 500: Internal Server Error" >&2
        exit 1
      fi
      if [ -f "$dir/tag-create-fails" ] && [[ "$ref" == refs/tags/* ]]; then
        echo "HTTP 500: Internal Server Error" >&2
        exit 1
      fi
      echo "create-ref $ref $sha" >> "$dir/actions.log"
      exit 0
    fi
    if [[ "$url" == *"/git/refs/tags/release-sync-retry/"* ]]; then
      if [ -f "$dir/delete-tag-fails" ]; then
        echo "HTTP 500: Internal Server Error" >&2
        exit 1
      fi
      echo "delete-tag \${url##*/git/refs/tags/release-sync-retry/}" >> "$dir/actions.log"
      exit 0
    fi
    branch="\${url##*git/refs/heads/}"
    if [ -f "$dir/delete-fails/$branch" ]; then
      code=$(cat "$dir/delete-fails/$branch")
      if [ "$code" = "404" ]; then
        echo "HTTP 404: Not Found" >&2
      else
        echo "HTTP 500: Internal Server Error" >&2
      fi
      exit 1
    fi
    echo "delete $branch" >> "$dir/actions.log"
    ;;
  "api repos/"*|"api https://"*)
    url="$2"
    case "$url" in
      *"/git/ref/heads/main") cat "$dir/main" ;;
      *"/git/ref/heads/release/"*)
        version="\${url##*/git/ref/heads/release/}"
        if [ -f "$dir/branches/$version" ]; then
          cat "$dir/branches/$version"
        else
          echo "HTTP 404: Not Found" >&2
          exit 1
        fi
        ;;
      *"/commits/"*)
        head="\${url##*/commits/}"
        if [ -f "$dir/parents/$head" ]; then
          cat "$dir/parents/$head"
        else
          echo "HTTP 404: Not Found" >&2
          exit 1
        fi
        ;;
      *) echo "unexpected api $url" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "unexpected gh $*" >&2
    exit 1
    ;;
esac
`;

interface Fixture {
    // Lines as the workflow's --jq prints them: "<number> <branch> <head>".
    prs: string[];
    main: string;
    parents?: Record<string, string>;
    states?: Record<string, string>;
    closeFails?: number[];
    deleteFails?: Record<string, string>;
    listFails?: boolean;
    dispatchFails?: boolean;
    alreadyClosed?: number[];
    paginateFails?: boolean;
    createRefFails?: boolean;
    dispatchFailsOnce?: boolean;
    reopenFails?: boolean;
    retryRefs?: string[];
    markersFail?: boolean;
    deleteTagFails?: boolean;
    closed?: Record<string, "ours" | "theirs">;
    closedRaw?: Record<string, unknown[]>;
    branches?: Record<string, string>;
    tagCreateFails?: boolean;
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runSync(fixture: Fixture, existing?: string) {
    const dir = existing ?? mkdtempSync(path.join(tmpdir(), "release-pr-sync-"));
    if (!existing) dirs.push(dir);
    for (const child of [
        "bin",
        "parents",
        "state",
        "close-fails",
        "delete-fails",
        "already-closed",
        "closed",
        "closed-raw",
        "branches",
    ]) {
        mkdirSync(path.join(dir, child), { recursive: true });
    }
    const gh = path.join(dir, "bin", "gh");
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    writeFileSync(
        path.join(dir, "prs"),
        fixture.prs.length > 0 ? `${fixture.prs.join("\n")}\n` : "",
    );
    writeFileSync(
        path.join(dir, "retry-refs"),
        fixture.retryRefs && fixture.retryRefs.length > 0
            ? `${fixture.retryRefs.join("\n")}\n`
            : "",
    );
    writeFileSync(path.join(dir, "main"), `${fixture.main}\n`);
    for (const [head, parent] of Object.entries(fixture.parents ?? {})) {
        writeFileSync(path.join(dir, "parents", head), `${parent}\n`);
    }
    for (const [number, state] of Object.entries(fixture.states ?? {})) {
        writeFileSync(path.join(dir, "state", number), `${state}\n`);
    }
    if (fixture.listFails) writeFileSync(path.join(dir, "list-fails"), "");
    if (fixture.dispatchFails) writeFileSync(path.join(dir, "dispatch-fails"), "");
    if (fixture.paginateFails) writeFileSync(path.join(dir, "paginate-fails"), "");
    if (fixture.createRefFails) writeFileSync(path.join(dir, "create-ref-fails"), "");
    if (fixture.dispatchFailsOnce) writeFileSync(path.join(dir, "dispatch-fails-once"), "");
    if (fixture.reopenFails) writeFileSync(path.join(dir, "reopen-fails"), "");
    if (fixture.markersFail) writeFileSync(path.join(dir, "markers-fail"), "");
    if (fixture.deleteTagFails) writeFileSync(path.join(dir, "delete-tag-fails"), "");
    if (fixture.tagCreateFails) writeFileSync(path.join(dir, "tag-create-fails"), "");
    for (const [version, kind] of Object.entries(fixture.closed ?? {})) {
        writeFileSync(path.join(dir, "closed", version), `${kind}\n`);
    }
    for (const [version, prs] of Object.entries(fixture.closedRaw ?? {})) {
        writeFileSync(path.join(dir, "closed-raw", version), JSON.stringify(prs));
    }
    for (const [version, sha] of Object.entries(fixture.branches ?? {})) {
        writeFileSync(path.join(dir, "branches", version), `${sha}\n`);
    }
    // A reused directory keeps the marker files but starts a clean action/call log for this run.
    if (existing) {
        rmSync(path.join(dir, "actions.log"), { force: true });
        rmSync(path.join(dir, "calls.log"), { force: true });
    }
    for (const number of fixture.closeFails ?? []) {
        writeFileSync(path.join(dir, "close-fails", String(number)), "");
    }
    for (const number of fixture.alreadyClosed ?? []) {
        writeFileSync(path.join(dir, "already-closed", String(number)), "");
    }
    for (const [branch, status] of Object.entries(fixture.deleteFails ?? {})) {
        const target = path.join(dir, "delete-fails", branch);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${status}\n`);
    }
    const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
            ...process.env,
            PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
            GH_FAKE_DIR: dir,
            GH_TOKEN: "test",
            REPO: "launchpad-kit/launchpad",
        },
    });
    const actions = existsSync(path.join(dir, "actions.log"))
        ? readFileSync(path.join(dir, "actions.log"), "utf8").trim().split("\n").filter(Boolean)
        : [];
    const calls = readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
    return { result, actions, calls, dir };
}

describe("release-PR sync workflow", () => {
    it("runs on a push to main and every five minutes", () => {
        expect(Object.keys(wf.on).toSorted()).toEqual(["push", "schedule"]);
        expect(wf.on.push).toEqual({ branches: ["main"] });
        expect(wf.on.schedule).toEqual([{ cron: "*/5 * * * *" }]);
        // `workflow_run` cannot be used: a run this workflow started with the repository token
        // does not fire it.
        expect(wf.on.workflow_run).toBeUndefined();
        expect(job.if).toBeUndefined();
    });

    it("holds one job with exactly the scopes closing, deleting, restoring and dispatching need", () => {
        expect(wf.permissions).toEqual({});
        expect(Object.keys(wf.jobs)).toEqual(["regenerate"]);
        expect(job.permissions).toEqual({
            "pull-requests": "write",
            contents: "write",
            actions: "write",
        });
        expect(wf.concurrency).toEqual({ group: "release-pr-sync", "cancel-in-progress": false });
    });

    it("checks nothing out and uses no action", () => {
        for (const step of job.steps) {
            expect(step.uses).toBeUndefined();
            expect(step.run).toBeTruthy();
        }
    });
});

describe("the regenerating step", () => {
    it("persists a marker, closes the stale PR, deletes its branch and dispatches", () => {
        const run = runSync({
            prs: ["12 release/0.1.0 aaaa launchpad-kit/launchpad"],
            main: "new",
            parents: { aaaa: "old" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/0.1.0 aaaa",
            "close 12",
            "delete release/0.1.0",
            "dispatch 0.1.0 stable",
            "delete-tag 0.1.0",
        ]);
        expect(run.calls.some((call) => call.includes("git/ref/heads/main"))).toBe(true);
        expect(run.calls.find((call) => call.startsWith("pr close 12"))).toContain("--comment");
        expect(run.calls.some((call) => call.startsWith("workflow run release-pr.yaml"))).toBe(
            true,
        );
    });

    it("passes an rc branch's channel through", () => {
        const run = runSync({
            prs: ["13 release/0.1.0-rc.1 bbbb launchpad-kit/launchpad"],
            main: "new",
            parents: { bbbb: "old" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/0.1.0-rc.1 bbbb",
            "close 13",
            "delete release/0.1.0-rc.1",
            "dispatch 0.1.0 rc",
            "delete-tag 0.1.0-rc.1",
        ]);
    });

    it("leaves a release PR that is already based on the live tip alone", () => {
        const run = runSync({
            prs: ["14 release/0.2.0 cccc launchpad-kit/launchpad"],
            main: "tip",
            parents: { cccc: "tip" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([]);
    });

    it("leaves a PR that is no longer open alone before touching it", () => {
        const run = runSync({
            prs: ["23 release/0.9.0 nnnn launchpad-kit/launchpad"],
            main: "new",
            parents: { nnnn: "old" },
            states: { 23: "MERGED" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([]);
    });

    it("removes the marker when the close is an already-closed no-op", () => {
        const run = runSync({
            prs: ["28 release/1.1.0 oooo launchpad-kit/launchpad"],
            main: "new",
            parents: { oooo: "old" },
            alreadyClosed: [28],
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/1.1.0 oooo",
            "delete-tag 1.1.0",
        ]);
    });

    it("regenerates only the PR behind the live tip, even when the run was triggered earlier", () => {
        const run = runSync({
            prs: [
                "15 release/0.2.0 dddd launchpad-kit/launchpad",
                "16 release/0.2.1 eeee launchpad-kit/launchpad",
            ],
            main: "tip",
            parents: { dddd: "older", eeee: "tip" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/0.2.0 dddd",
            "close 15",
            "delete release/0.2.0",
            "dispatch 0.2.0 stable",
            "delete-tag 0.2.0",
        ]);
    });

    it("fails when a PR cannot be closed, leaving the marker", () => {
        const run = runSync({
            prs: ["19 release/0.4.0 hhhh launchpad-kit/launchpad"],
            main: "new",
            parents: { hhhh: "old" },
            states: { 19: "OPEN\nOPEN" },
            closeFails: [19],
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual(["create-ref refs/tags/release-sync-retry/0.4.0 hhhh"]);
    });

    it("reopens the PR when its branch cannot be deleted, so the next run retries", () => {
        const run = runSync({
            prs: ["21 release/0.6.0 jjjj launchpad-kit/launchpad"],
            main: "new",
            parents: { jjjj: "old" },
            deleteFails: { "release/0.6.0": "500" },
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/0.6.0 jjjj",
            "close 21",
            "reopen 21",
        ]);
    });

    it("tolerates a branch that is already gone, and dispatches", () => {
        const run = runSync({
            prs: ["20 release/0.5.0 iiii launchpad-kit/launchpad"],
            main: "new",
            parents: { iiii: "old" },
            deleteFails: { "release/0.5.0": "404" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/0.5.0 iiii",
            "close 20",
            "dispatch 0.5.0 stable",
            "delete-tag 0.5.0",
        ]);
    });

    it("restores the branch and reopens the PR when the dispatch fails", () => {
        const run = runSync({
            prs: ["25 release/0.8.0 mmmm launchpad-kit/launchpad"],
            main: "new",
            parents: { mmmm: "old" },
            dispatchFails: true,
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/0.8.0 mmmm",
            "close 25",
            "delete release/0.8.0",
            "create-ref refs/heads/release/0.8.0 mmmm",
            "reopen 25",
        ]);
    });

    it("retries a failed dispatch once before rolling back", () => {
        const run = runSync({
            prs: ["32 release/1.5.0 ssss launchpad-kit/launchpad"],
            main: "new",
            parents: { ssss: "old" },
            dispatchFailsOnce: true,
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/1.5.0 ssss",
            "close 32",
            "delete release/1.5.0",
            "dispatch 1.5.0 stable",
            "delete-tag 1.5.0",
        ]);
    });

    it("fails with recovery commands when the branch cannot be restored", () => {
        const run = runSync({
            prs: ["31 release/1.4.0 rrrr launchpad-kit/launchpad"],
            main: "new",
            parents: { rrrr: "old" },
            dispatchFails: true,
            createRefFails: true,
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/1.4.0 rrrr",
            "close 31",
            "delete release/1.4.0",
        ]);
        expect(run.result.stdout).toContain("could not restore release/1.4.0");
        expect(run.result.stdout).toContain("restore it with: gh api -X POST");
        expect(run.result.stdout).toContain("then reopen it with: gh pr reopen 31");
    });

    it("does not close anything when the retry marker cannot be persisted", () => {
        const run = runSync({
            prs: ["36 release/1.8.0 wwww launchpad-kit/launchpad"],
            main: "new",
            parents: { wwww: "old" },
            tagCreateFails: true,
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([]);
        expect(run.result.stdout).toContain("could not persist a retry marker for 1.8.0");
    });

    it("fails with a reopen command when the PR cannot be reopened", () => {
        const run = runSync({
            prs: ["33 release/1.6.0 tttt launchpad-kit/launchpad"],
            main: "new",
            parents: { tttt: "old" },
            dispatchFails: true,
            reopenFails: true,
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/1.6.0 tttt",
            "close 33",
            "delete release/1.6.0",
            "create-ref refs/heads/release/1.6.0 tttt",
        ]);
        expect(run.result.stdout).toContain("could not reopen #33");
        expect(run.result.stdout).toContain("gh pr reopen 33 --repo");
    });

    it("queues a marker when a failed delete cannot reopen the PR", () => {
        const run = runSync({
            prs: ["34 release/1.7.0 uuuu launchpad-kit/launchpad"],
            main: "new",
            parents: { uuuu: "old" },
            deleteFails: { "release/1.7.0": "500" },
            reopenFails: true,
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([
            "create-ref refs/tags/release-sync-retry/1.7.0 uuuu",
            "close 34",
        ]);
        expect(run.result.stdout).toContain("could not reopen #34");
    });

    it("drains a queued retry marker when no PR for the version is open", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.1 old"],
            main: "new",
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "delete release/0.1.0-rc.1",
            "dispatch 0.1.0 rc",
            "delete-tag 0.1.0-rc.1",
        ]);
    });

    it("keeps a retry marker when its dispatch fails", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.2 old"],
            main: "new",
            dispatchFails: true,
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual(["delete release/0.1.0-rc.2"]);
        expect(run.result.stdout).toContain("the marker stays for the next run");
    });

    it("warns when the drained marker cannot be deleted, after dispatching", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.4 old"],
            main: "new",
            deleteTagFails: true,
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual(["delete release/0.1.0-rc.4", "dispatch 0.1.0 rc"]);
        expect(run.result.stdout).toContain("could not remove the retry marker for 0.1.0-rc.4");
    });

    it("stops when the retry markers cannot be listed", () => {
        const run = runSync({ prs: [], main: "new", markersFail: true });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([]);
    });

    it("drops a marker when a maintainer closed the PR, and does not regenerate", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.6 old"],
            main: "new",
            closed: { "0.1.0-rc.6": "theirs" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual(["delete-tag 0.1.0-rc.6"]);
        expect(run.result.stdout).toContain("a maintainer closed release/0.1.0-rc.6");
    });

    it("ignores an older superseded PR when the newest closed PR was closed by a maintainer", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.10 old"],
            main: "new",
            closedRaw: {
                "0.1.0-rc.10": [
                    { number: 1, comments: [{ body: "superseded by the sync" }] },
                    { number: 2, comments: [] },
                ],
            },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual(["delete-tag 0.1.0-rc.10"]);
        expect(run.result.stdout).toContain("a maintainer closed release/0.1.0-rc.10");
    });

    it("regenerates when the newest closed PR carries the sync's comment", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.11 old"],
            main: "new",
            closedRaw: {
                "0.1.0-rc.11": [
                    { number: 1, comments: [] },
                    { number: 2, comments: [{ body: "superseded by the sync" }] },
                ],
            },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "delete release/0.1.0-rc.11",
            "dispatch 0.1.0 rc",
            "delete-tag 0.1.0-rc.11",
        ]);
    });

    it("regenerates a marker for a PR this workflow closed", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.7 old"],
            main: "new",
            closed: { "0.1.0-rc.7": "ours" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "delete release/0.1.0-rc.7",
            "dispatch 0.1.0 rc",
            "delete-tag 0.1.0-rc.7",
        ]);
    });

    it("deletes the old branch when it still sits at the marker's commit", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.12 old"],
            main: "new",
            branches: { "0.1.0-rc.12": "old" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([
            "delete release/0.1.0-rc.12",
            "dispatch 0.1.0 rc",
            "delete-tag 0.1.0-rc.12",
        ]);
    });

    it("leaves the marker when the version's branch already holds a replacement", () => {
        const run = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.8 old"],
            main: "new",
            branches: { "0.1.0-rc.8": "repl" },
            parents: { repl: "new" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([]);
        expect(run.result.stdout).toContain("already holds a newer replacement");
    });

    it("does not dispatch twice when the marker survived an accepted dispatch", () => {
        const first = runSync({
            prs: [],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.9 old"],
            main: "new",
            deleteTagFails: true,
        });
        expect(first.result.status).toBe(0);
        expect(first.actions).toEqual(["delete release/0.1.0-rc.9", "dispatch 0.1.0 rc"]);

        // The accepted dispatch pushes release/<version>; a second sync sees it and leaves the marker.
        writeFileSync(path.join(first.dir, "branches", "0.1.0-rc.9"), "repl\n");
        writeFileSync(path.join(first.dir, "parents", "repl"), "new\n");
        const second = runSync(
            { prs: [], retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.9 old"], main: "new" },
            first.dir,
        );
        expect(second.result.status).toBe(0);
        expect(second.actions).toEqual([]);
        expect(second.result.stdout).toContain("already holds a newer replacement");
    });

    it("leaves a marker for an open PR to the PR pass, which cleans up a current one", () => {
        const run = runSync({
            prs: ["35 release/0.1.0-rc.5 vvvv launchpad-kit/launchpad"],
            retryRefs: ["refs/tags/release-sync-retry/0.1.0-rc.5 old"],
            main: "new",
            parents: { vvvv: "new" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual(["delete-tag 0.1.0-rc.5"]);
    });

    it("does not warn about ordinary pull requests", () => {
        const run = runSync({
            prs: ["27 feature/ordinary aaaa launchpad-kit/launchpad"],
            main: "new",
            parents: { aaaa: "old" },
        });
        expect(run.result.status).toBe(0);
        expect(run.result.stdout).not.toContain("is not a version");
        expect(run.actions).toEqual([]);
    });

    it("leaves unknown versions, leading zeros and a branch without a head alone", () => {
        const run = runSync({
            prs: [
                "22 release/feature kkkk launchpad-kit/launchpad",
                "23 release/01.2.3 llll launchpad-kit/launchpad",
                "24 release/0.7.0 launchpad-kit/launchpad",
                "26 release/9.9.9 zzzz someone/launchpad",
            ],
            main: "new",
            parents: { kkkk: "old", llll: "old" },
        });
        expect(run.result.status).toBe(0);
        expect(run.actions).toEqual([]);
    });

    it("fails when the open PRs cannot be read", () => {
        const run = runSync({ prs: [], main: "new", listFails: true });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([]);
    });

    it("changes nothing when a later page fails: the list is complete before any action", () => {
        const run = runSync({
            prs: ["29 release/1.2.0 pppp launchpad-kit/launchpad"],
            main: "new",
            parents: { pppp: "old" },
            paginateFails: true,
        });
        expect(run.result.status).not.toBe(0);
        expect(run.actions).toEqual([]);
    });

    it("never reads the triggering SHA, paginates every page, and keeps forks out", () => {
        expect(script).toContain("open_prs=$(gh api --paginate");
        expect(script).toContain('done <<< "$open_prs"');
        expect(script).toContain("markers=$(gh api --paginate");
        expect(script).toContain("gh api --paginate");
        expect(script).toContain("/pulls?state=open");
        expect(script).toContain("per_page=100");
        expect(script).toContain("--ref main");
        expect(script).toContain("state=open");
        expect(script).toContain("base=main");
        expect(script).toContain(".head.repo.full_name");
        expect(script).toContain(".head.ref");
        expect(script).toContain(".head.sha");
        expect(script).not.toContain("--limit 1000");
        expect(script).not.toContain("gh pr list --base main");
        expect(script).toContain('gh pr list --repo "$REPO" --state closed');
        expect(script).not.toContain("github.sha");
        expect(script).toContain('[ "$source" = "$REPO" ]');
    });
});
