# @launchpad/auth

Better Auth configuration for the controller. Depends on `@launchpad/database`.

- `loadAuthConfig(env)` validates the `LAUNCHPAD_*` settings and fails fast.
- `createAuth({ db, config })` builds Better Auth with email/password, the
  organization plugin, database-backed rate limiting and an instance `role`
  (`user` or `operator`, never settable from request input). Public sign-up and
  user-created organizations are off; nothing connects at import time.
- `setupFirstOperator` creates the single operator under an advisory lock;
  `provisionUser` creates ordinary accounts offline; `resetPassword` recovers a user.
- `allowLoginAttempt` throttles sign-in per client and email, and per email.

Integration tests need a disposable PostgreSQL server; see
[CONTRIBUTING.md](../../CONTRIBUTING.md).
