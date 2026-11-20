# Deploy a static site

For an instance operator or automation with an API key. Deployments are **off by default**. They need
the controller and a worker configured as in [install](install.md) (step 6), a Dokku host you own, and a
[backup/restore rehearsal](restore.md). Nothing here authorizes starting services or changing real
infrastructure; try it on a disposable Dokku first.

## Model

An **app** belongs to a project. Each **deployment** is a new immutable release: its own opaque Dokku
app (`lp-` and ten characters), its own hostname, and one recorded image identity. A deployment is never
redeployed in place, and a failed one never touches another. An app has at most one unfinished
deployment; quotas limit apps and retained deployments (`LAUNCHPAD_MAX_APPS`,
`LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP`, `LAUNCHPAD_MAX_DEPLOYMENTS`). Aliases can be created
(`POST /apps/{appId}/aliases` with `{"slug":"prod"}`, `app:alias:manage`, needs `LAUNCHPAD_ALIASES=on`)
and then pointed at any succeeded deployment of the same app (see [Promote](#promote-an-alias)).
Automatic expiry is not built: nothing deletes a deployment unless you ask.

Keys need `app:read`, `app:deploy`, `app:delete`, `app:promote` or `app:alias:manage`. The dashboard key form does not offer these scopes yet:
an owner or admin signed in fresh issues the key through `POST /api/v1/organizations/{orgId}/api-keys` (see
[the controller README](../apps/controller/README.md)). A key never exceeds its creator's role (viewer reads;
deployer creates apps, deploys and deletes). A project-limited key reaches only its projects and may deploy
only archives uploaded through the app's project.

## Example

```sh
API=https://controller.example/api/v1/organizations/$ORG
H="authorization: Bearer $LAUNCHPAD_API_KEY"

# 1. Upload a gzip tar archive with index.html at its root.
tar -C ./site -czf site.tgz .
curl -sS -H "$H" -H 'content-type: application/gzip' --data-binary @site.tgz \
  "$API/projects/$PROJECT/artifacts"                  # -> { "id": "<artifact>", ... }

# 2. Create an app once.
curl -sS -H "$H" -H 'content-type: application/json' -d '{"slug":"web"}' \
  "$API/projects/$PROJECT/apps"                       # -> { "id": "<app>", ... }

# 3. Queue a deployment (202, status "queued"). Add "spa": true for single-page-app fallback.
curl -sS -H "$H" -H 'content-type: application/json' \
  -d '{"artifactId":"<artifact>","ttl":"7d"}' "$API/apps/<app>/deployments"

# 4. Follow it. Status goes queued, preparing, building, deploying, verifying, succeeded.
curl -sS -H "$H" "$API/deployments/<deployment>"
curl -sS -H "$H" "$API/deployments/<deployment>/events?after=0"
```

The response carries the deployment's own `hostname`; point DNS (or your private routing, see
[access](access.md)) at the Dokku proxy. `failed`, `cancelled` and `succeeded` deployments can be deleted.

## Promote an alias

An alias is a stable hostname of its own. It points at nothing until you promote a deployment to it, and
promotion never happens implicitly. This needs `LAUNCHPAD_ALIASES=on` on the controller **and** the worker, which also
needs the router settings ([install](install.md) step 6).

```sh
# 1. Create the alias once (it starts unbound: a fixed 404).
curl -sS -H "$H" -H 'content-type: application/json' -d '{"slug":"prod"}' "$API/apps/<app>/aliases"

# 2. Point it at a succeeded deployment. Idempotency-Key is required; expectedGeneration is the
#    alias's reservedGeneration that you last read ("0" for a new alias). 202, status "queued".
curl -sS -H "$H" -H 'content-type: application/json' -H 'Idempotency-Key: release-42' \
  -d '{"targetDeploymentId":"<deployment>","expectedGeneration":"0"}' \
  "$API/aliases/<alias>/promotions"

# 3. Follow it. Status goes queued, applying, verifying, succeeded.
curl -sS -H "$H" "$API/aliases/<alias>/operations"      # newest generation first
curl -sS -H "$H" "$API/aliases/<alias>"                  # state, targetDeploymentId, generations
```

A key needs `app:promote`; withdrawing needs `app:alias:manage`, and the two are not interchangeable.
The same `Idempotency-Key` with the same body returns the same operation; with a different body it is a 409.
A stale `expectedGeneration` is a 409 as well: read the alias again. To roll back, promote an older
deployment. The worker sends the route to the router, reads it back, probes the alias hostname for the
deployment's identity, and only then commits; until then the old target keeps serving, and the previous
target stays pinned and cannot be deleted. Withdraw an alias (its hostname then answers a fixed 404 and stays reserved):

```sh
curl -sS -X DELETE -H "$H" -H 'content-type: application/json' -H 'Idempotency-Key: retire-1' \
  -d '{"expectedGeneration":"3"}' "$API/aliases/<alias>"   # 202
```

If the router's reply is lost or late, the operation becomes `reconciliation-needed` and the alias
`binding-uncertain` or `withdrawal-uncertain`: it refuses new requests and keeps its targets pinned. Read the
router, then record what you found; the command re-reads the exact route and queues a correction:

```sh
bun .output/admin.mjs promotion-reconcile --operation <id> --target <deployment> \
  --i-have-verified-the-router-by-exact-route          # or --withdraw
```

## Shut down an app

```sh
curl -sS -X DELETE -H "$H" "$API/apps/<app>"   # 202; repeat it to continue
```

Admins and owners only; a key needs all of `app:delete`, `app:alias:manage` and `app:promote`. The app stops
accepting deployments and promotions, every bound alias is withdrawn, and **only after the worker has
verified every route is gone** is each deployment deleted. Nothing is destroyed while a route is live or
uncertain. The response lists what was queued and what still blocks it (`blockedBy`); repeat the request until the app
reads `deleted`. Its identity, hostnames and Dokku names stay reserved forever.

## Delete

```sh
curl -sS -X DELETE -H "$H" "$API/deployments/<deployment>"   # 202
```

Only a finished deployment can be deleted. The worker destroys the deployment's own Dokku app (never a
name it did not create), confirms it is gone, removes that deployment's local image, and marks it
`deleted`. Reads then show `desiredState` `deleting` and then `deleted`. The hostname and Dokku name stay
reserved forever.

## When the worker cannot confirm something

If a Dokku or Docker step ends uncertain (a lost reply, a worker killed mid-step), the deployment becomes
`reconciliation-needed` and blocks its app; a held deletion keeps `desiredState` `deleting` and a
`deletion-reconciliation-needed` event. Nothing retries these automatically. Check Dokku **by exact
name**, then record what you saw:

```sh
bun .output/admin.mjs deployment-reconcile --deployment <id> \
  --outcome failed-clean --i-have-verified-dokku-by-exact-name
```

Outcomes: `succeeded` (deployment: it serves its recorded image; deletion: the app is gone),
`failed-clean` (deployment: nothing of it exists; deletion: the app was not destroyed), `failed-owned`
(deployment: its app exists, so a later deletion may destroy it) and `abandon` (deployment; nothing
unrecorded is ever destroyed). The command never calls Dokku and is audited.

## Turn it off

Set `LAUNCHPAD_DEPLOYMENTS=off` on the controller and the worker and restart both: writes then answer 503
while reads still work, and the worker goes idle. Stop enabled workers before backing up, upgrading or restoring; after a restore, deployments stay refused until you
run `recovery-clear` ([restore](restore.md)).
