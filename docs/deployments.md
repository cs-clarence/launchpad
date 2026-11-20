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
`LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP`, `LAUNCHPAD_MAX_DEPLOYMENTS`). Aliases, promotion and automatic
expiry are not built.

Keys need `app:read`, `app:deploy` or `app:delete`. The dashboard key form does not offer these scopes yet:
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
