# Services

For contributors implementing controller use cases. Keep this page current
when the service boundary changes.

Framework-independent application logic belongs here. The bootstrap contains
only `getControllerInfo`, which has no network, database, or HTTP dependencies.
Elysia handlers delegate to services, not the other way around.

See [patterns](../../docs/patterns/README.md) and
[checks](../../CONTRIBUTING.md).
