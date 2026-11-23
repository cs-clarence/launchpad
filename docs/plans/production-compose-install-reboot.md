# Clean Compose install and host reboot rehearsal

For maintainers finishing the [Compose follow-ups](production-compose-follow-up.md).
This is a medium-sized, high-risk operational rehearsal: it provisions a guest,
starts a Docker engine with root-equivalent fixture services, and reboots the
guest. Use one disposable VM with an untouched Linux cloud image, no production
credentials or host mounts, a distinct Docker engine and project, and loopback
ports only. Do not reboot the host running the VM or its Docker engine.

The [host-loss rehearsal](production-fresh-host-recovery.md) started with a
Docker-ready guest and restored already-configured state. It did not test
installing a supported Docker toolchain from scratch or a reboot with the
normal restart policies in effect.

## Steps and pass conditions

1. **Provision an empty guest.** Record the OS, engine ID, Docker Engine,
   Compose and Buildx versions and the source revision. Use a supported
   package source. Require an empty Docker inventory apart from built-in
   networks, then pass `omni -i run check:compose:rehearsal` before starting
   services. If tooling fails, fix it in the guest, not in the Compose
   validation. Discard only the recorded guest if provisioning cannot finish.
2. **Install the fixture using the documented order.** Follow
   [Prepare](../production-compose.md#prepare) and
   [First start](../production-compose.md#first-start-in-order) with a fixture
   CA, pinned Dokku SSH key, fresh state mounts, `initial-network`, explicit
   migrations, operator setup and router initialization. Record any step the
   instructions missed. The install passes when both preview hosts and a
   promoted alias serve the expected deployment identities, using the same
   probes as the [baseline](production-compose-rehearsal.md). Leave those
   deployments and the alias in place. The baseline task tears them down;
   do not run it unchanged and call the result a reboot test.
3. **Reboot once, while idle.** Verify no deployment or Dokku operation is in
   flight on the guest. Record the boot ID, volume names, apps network, engine
   ID, pinned SSH fingerprint, route generation and epoch. Reboot the guest
   itself. Do not run `compose up`, `migrate`, router `init` or `rotate` to
   make the outcome pass. Record that the boot ID changed but the engine ID
   and persistent state did not. With a bounded wait, require both preview
   identities and the alias to return, and authenticated router readback to
   match. Health checks alone are not enough.
4. **Verify writes and clean up.** Promote at a higher generation, withdraw
   to a verified 404 and delete the fixture deployments through the API.
   Verify exact-name cleanup and remove only the disposable fixture. If
   startup, identities or mutations fail, stop identified writers, preserve
   the guest and inventory, and record which check blocked the run.

This rehearses an orderly, idle reboot. It does not test sudden power loss,
in-flight deploy drain, a version upgrade or rollback, or public ingress.

## Result (2026-11-23)

The rehearsal provisioned an untouched Debian 13 QEMU/KVM guest, installed
Engine 29.10.0, Compose 5.8.0 and Buildx 0.39.1 from Docker's official package
repository, and passed the Compose preflight. A guest-only adaptation of the
baseline at `efc5f282` kept the idle, aliases-on fixture running.

The guest boot ID changed. Without running Compose startup, migrations,
router initialization or rotation after reboot, all five original Compose
containers returned healthy. The engine ID, volume identities, network IDs,
Dokku SSH fingerprint, router epoch, and alias target at generation 2
matched the pre-reboot snapshot. Both preview hosts and the alias served
their expected deployment identities.

A promotion after reboot served A at generation 3, and withdrawal at
generation 4 returned 404. Both deployments were deleted through the API;
no matching app containers or images remained. The fixture guest shut down
and its disk and SSH materials were removed. This is a result for one
disposable install, not a claim about the production host.
