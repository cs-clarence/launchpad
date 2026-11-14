# Dokku boundary

For contributors adding the controller's Dokku adapter. Keep this page current
when connectivity or supported operations change.

Only the `DokkuConnection` configuration type exists. There is no SSH client,
command execution, credential loading, or host connection.

Future work must verify host keys and expose narrow validated operations, not
an arbitrary shell endpoint. Keep private keys outside container images.
The controller image does not mount Docker's socket.

See [patterns](../../docs/patterns/README.md).
