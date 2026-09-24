# Security policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Prefer GitHub's private vulnerability reporting for this repository when it is
enabled (Security → Advisories → Report a vulnerability). If that path is
unavailable, email **support@thephotobase.com** with a description of the
issue, steps to reproduce, and any relevant logs or patches. Do not include
live credentials or refresh tokens.

We aim to acknowledge reports within a few business days and to keep you
informed while a fix is prepared.

## Scope

In scope: calsync itself (CLI, daemon, onboarding dashboard, sync engine),
including multi-tenant isolation, OAuth handling, and local state storage.

Out of scope unless they clearly affect calsync: third-party Google outages,
compromised operator machines, and misconfigured reverse proxies that forward
untrusted identity headers.
