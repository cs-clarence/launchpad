# Controller, worker and shared client core architecture

Status: accepted by the user on 2026-11-14. For contributors building Launchpad; it does not
by itself authorize milestones beyond those the plan names as authorized.

## Context

Launchpad needs one authenticated control plane for a dashboard, CLI and local
MCP server, with privileged Docker/Dokku access kept away from request handling.

## Decision

- One controller image serves the dashboard and the Elysia API on one origin.
- A separate privileged worker runs builds and Dokku SSH operations.
- CLI and local MCP share one client core that talks to the controller, never to
  Dokku or the database.
- Organization boundaries do not isolate hostile workloads; workloads are trusted.

## Alternatives considered

- One privileged process: rejected, it ties request availability to builds and
  exposes Docker and Dokku credentials to the HTTP surface.
- CLI/MCP talking to Dokku directly: rejected, it bypasses authentication,
  authorization and audit and spreads credentials to clients.

## Consequences

Services stay framework-independent so the API can later be extracted. Only the
worker holds Docker and Dokku credentials. See the
[application design](../design/application.md), especially its trust-boundary
sections.
