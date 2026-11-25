# Run Launchpad on your machine

For a developer who wants a working local controller to try the dashboard, the CLI and the
API. You finish with a migrated database, an operator and an owner account, an organization,
a project, an API key and a saved `launchpad` profile. Nothing here deploys sites: apps and
deployments stay off (see [deployments](deployments.md) for that).

You need [Bun](https://bun.sh) 1.4.4, [Omni](https://github.com/omni-oss/omni), a checkout of
this repository, and a PostgreSQL 17 server you can reach. Run every command from the
repository root unless a step says otherwise.

## Set it up

1. Install the dependencies and the agent context:

    ```sh
    bun install --frozen-lockfile
    omni remote-sources install && omni projection sync
    ```

2. Start a PostgreSQL 17. Any server works; this runs a throwaway one in Docker, listening
   only on your machine. Choose your own password:

    ```sh
    docker run -d --name launchpad-dev-db -e POSTGRES_USER=launchpad \
      -e POSTGRES_PASSWORD=choose-a-password -e POSTGRES_DB=launchpad \
      -p 127.0.0.1:5432:5432 postgres:17-alpine
    ```

3. Copy the controller's example settings and edit them:

    ```sh
    cp apps/controller/.env.local.example apps/controller/.env.local
    openssl rand -base64 48
    mkdir -p apps/controller/.data/controller
    ```

    In `apps/controller/.env.local` set:
    - `DATABASE_URL` to your server, for the container above
      `postgresql://launchpad:choose-a-password@127.0.0.1:5432/launchpad`.
    - `LAUNCHPAD_AUTH_SECRET` to the `openssl` output (at least 32 characters).
    - `LAUNCHPAD_BASE_URL` to `http://127.0.0.1:3000`.

    Leave the rest as it is; `LAUNCHPAD_DEPLOYMENTS` stays off. The directory in
    `LAUNCHPAD_DATA_DIR` (default `.data/controller`, relative to `apps/controller`) must exist
    before the controller answers requests, which is what the `mkdir` is for.

    `LAUNCHPAD_BASE_URL` is the one setting that is easy to get wrong. The controller trusts
    only its origin, and refuses a session request that carries a different `Origin`. An
    `http` origin on loopback is accepted: the controller marks its cookies `Secure` only for
    `https`, and requires `https` only when `LAUNCHPAD_APPS_DOMAIN` is set or
    `LAUNCHPAD_DEPLOYMENTS` is `on`, neither of which this guide uses. The origin must equal
    the address you actually open. `omni -i run dev` loads `apps/controller/.env.local` and the dev
    server honors its `PORT`, so with the example file it listens on `127.0.0.1:3000` (Vite's own
    default, 5173, applies only if `PORT` is unset). If you change `PORT`, change
    `LAUNCHPAD_BASE_URL` and the seed's `--controller` to match. If the port is taken the dev
    server may pick another one and the origin no longer matches; free the port and restart.

4. Start the controller and leave it running in one terminal:

    ```sh
    omni -i run dev -p @launchpad-kit/controller
    ```

5. In another terminal, seed it:

    ```sh
    omni -i run local:seed
    ```

    This applies the database migrations, creates the operator and the owner, then the
    organization `local` and the project `demo`, issues a 90-day API key and saves it as the
    `launchpad` profile `local`. It prints what it did and where files went, never a password
    or key. Pick other names with options, for example:

    ```sh
    omni -i run local:seed -a "options=--org acme --project site --profile acme"
    ```

    `omni -i run local:seed -a options=--help` lists every option.

    The seed signs in as the operator and the owner several times. The controller throttles
    sign-in to 5 attempts a minute per account, so if a sign-in right afterwards answers "Too many
    requests", wait the minute it names and try again.

6. Check it. Build the CLI once, then call the controller with the saved key:

    ```sh
    omni -i run build -p @launchpad-kit/cli
    alias launchpad="bun $PWD/apps/cli/dist/index.js"
    launchpad whoami
    launchpad api organizations/{org}/projects
    ```

    `whoami` names the key's organization and `api` lists its projects, including `demo`. If
    you already had another profile, the new one is saved but not selected: run
    `launchpad profile use local`.

## What the seed leaves behind

| What                       | Where                                                                   |
| -------------------------- | ----------------------------------------------------------------------- |
| Operator and owner account | `operator@launchpad.local` and `owner@launchpad.local`                  |
| Their passwords            | `<config>/local-operator.password` and `local-owner.password`, mode 600 |
| The API key                | The `launchpad` profile, in `<config>/credentials.json`, mode 600       |

`<config>` is `--out` if given, else `$LAUNCHPAD_CONFIG_DIR`, else `$XDG_CONFIG_HOME/launchpad`,
else `~/.config/launchpad`. `LAUNCHPAD_CONFIG_DIR` and `XDG_CONFIG_HOME` must be absolute (the CLI does not expand them; the script refuses otherwise). It is resolved to an absolute path and must be a directory you own,
not a link and not writable by others (it is created mode 700); a path with spaces or quotes is
refused. The key lasts 90 days and has only the scopes `organization:read`, `project:read`,
`project:create` and `app:read`, which is what this guide uses; revoke it on the organization
page of the dashboard.

Sign in to the dashboard at the controller's address as the owner, with the password from its
file. The operator creates organizations and has no access inside them. `--out <dir>` moves
all of these; set `LAUNCHPAD_CONFIG_DIR` to the same directory so the CLI finds the profile.

## Use it day to day

Start PostgreSQL and `omni -i run dev -p @launchpad-kit/controller` again. Nothing needs
seeding twice: the seed is safe to re-run and changes nothing that already exists. It issues
a second key only with `--new-key`, and it replaces a profile that does not work for this
controller only with `--force`. To start over, drop the database (for the container above,
`docker rm -f launchpad-dev-db`) and seed again; the script never deletes anything, and it
reuses the password files it wrote earlier. A profile left over from the old database then
holds a dead key, so seed again with `--force`.

## If it fails

Each failure prints one message and exits nonzero.

| Message starts with                            | What to do                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Cannot reach the controller`                  | Start the controller (step 4), or fix `--controller`.                                            |
| `... was refused (403)`                        | `LAUNCHPAD_BASE_URL` and the origin the script sends differ; make them equal or pass `--origin`. |
| `... is not ready (503)`                       | The database is unreachable or unmigrated, or the `LAUNCHPAD_DATA_DIR` directory is missing.     |
| `migrate failed`, `DATABASE_URL is not set`    | Check `DATABASE_URL` and that PostgreSQL is running.                                             |
| `The controller rejected the operator sign-in` | The operator password file holds the wrong password; put the right one in it.                    |
| `... is not on this machine`                   | The script refuses a controller that is not loopback unless you pass `--allow-remote`.           |
| `... is readable by other users`               | Run `chmod 600` on the file it names.                                                            |
| `already exists, but no password file`         | An account exists whose password the script does not have; write it to the file named.           |

Passwords never travel in an argument or the environment: the admin commands read them from
the mode-600 files. The script uses `http` only for loopback and needs `https` for anything
else.

## Let other people reach it

This is for a short trial, not hosting. The controller has not had a review for exposure to
the public internet; read [keep management private](access.md) first, put a tunnel or a VPN
such as Tailscale in front of it, and do not publish it directly.

1. Run the built server, not the dev server. From the repository root build it, then start it
   from `apps/controller`, where Bun reads `.env.local` itself (no `source` needed):

    ```sh
    omni -i run build -p @launchpad-kit/controller
    cd apps/controller && bun .output/server/index.mjs
    ```

    It listens on `HOST` and `PORT` from `.env.local`. `HOST=127.0.0.1` binds loopback only;
    with `HOST` unset it also bound `127.0.0.1` in the check below, and `HOST=0.0.0.0` made it
    answer on the machine's LAN address. Keep `127.0.0.1` so only the tunnel reaches it.

2. Set `LAUNCHPAD_BASE_URL` to the public `https` origin the tunnel serves, exactly (no path),
   and restart the controller; it reads its settings only at start. Cookie-carrying requests that
   are not `GET`, `HEAD` or `OPTIONS` must send `Origin` equal to it. If it differs
   (for example it is `http://127.0.0.1:3000` while people use `https://control.example.com`), sign-in answers 403
   `INVALID_ORIGIN` ("Invalid origin"), other session requests answer 403 `forbidden-origin`, and
   `launchpad api --session` prints: "The controller accepts only the exact origin set as its
   LAUNCHPAD_BASE_URL; an http/https or proxy-host mismatch looks like this." Fix the setting
   rather than the client. With an `https` origin the session cookie is named
   `__Secure-better-auth.session_token` and is `Secure`; with an `http` origin it is
   `better-auth.session_token` and not `Secure`.
3. Set `LAUNCHPAD_PUBLIC_SIGNUP=false` (the default) and `LAUNCHPAD_API_DOCS=false`. With the
   first, `POST /api/auth/sign-up/email` answers 400 `EMAIL_PASSWORD_SIGN_UP_DISABLED`; with
   `true` it created an account. With the second, `/api/openapi` and `/api/openapi/json` answer 404. The Scalar script under `/_scalar/<version>/standalone.js` is still served: it is a
   static file and holds no API data.
4. Set `LAUNCHPAD_TRUSTED_PROXY=true` only if exactly one proxy sits in front and appends the
   client address to `X-Forwarded-For`; otherwise leave it `false`. The controller uses the
   rightmost entry, so a client-supplied `X-Forwarded-For` cannot change the address as long as
   that proxy appends. Sign-in is limited per client address and account (5 a minute), per
   account across all addresses (20 in ten minutes) and, separately, per address (5 a minute).
   Observed against a proxy that appends the peer address:

    | Setting | Path                                                  | Result                                                                                                                  |
    | ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
    | `false` | through the proxy, spoofed `X-Forwarded-For`          | 5 attempts pass, then 429: the address is always the proxy's, so spoofing changes nothing                               |
    | `false` | through the proxy, a second client address            | still 429: every client shares the proxy's address, so one person's failed sign-ins lock others out of the same account |
    | `true`  | through the proxy, spoofed `X-Forwarded-For`          | 5 pass, then 429: the proxy's appended address wins                                                                     |
    | `true`  | through the proxy, a second client address            | not throttled by the first client's attempts                                                                            |
    | `true`  | straight to the controller, spoofed `X-Forwarded-For` | the per-address limit is bypassed; only the per-account cap of 20 in ten minutes stops it                               |

    So never set `true` if anything can reach the controller without the proxy. Not verified
    against a real Cloudflare Tunnel or Tailscale: check what yours puts in `X-Forwarded-For`.

5. Seed through the loopback address while sending the public origin (the script sends the
   controller address as the origin unless you pass `--origin`, and the controller then refuses
   with "was refused (403)"). The profile it saves points at the loopback address, which is
   right on this machine:

    ```sh
    omni -i run local:seed -a "options=--controller http://127.0.0.1:3000 --origin https://control.example.com --profile tunnel"
    ```

    Other people use the public address: the owner issues them a key in the dashboard and they
    run `launchpad login --controller https://control.example.com --key-file <file>`.

6. Check `https://control.example.com/api/health`: it answers 200 `{"name":"launchpad",...}`
   through the proxy.

The CLI needs `https` for a controller that is not loopback. A tunnel with a public certificate
needs nothing more. If you test with a private certificate authority or a self-signed
certificate, Bun does not trust it, and the CLI fails with only "Could not reach the controller."
Run it with `NODE_EXTRA_CA_CERTS=<ca.pem>` (verified: `login`, `whoami`, `api` and
`api --session` then work over `https`); `SSL_CERT_FILE` also worked for Bun's `fetch`.
Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Both [access](access.md) and the [controller README](../apps/controller/README.md) describe each
setting.
