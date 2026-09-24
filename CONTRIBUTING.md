# Contributing

Bug reports and pull requests are welcome. For larger changes, open an issue
first to discuss the problem and proposed behavior.

Use Node.js from `.nvmrc`, then run:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Tests use fake calendar clients, temporary databases, and local HTTP servers;
they do not need Google credentials. Your environment must permit local socket
listeners. For real calendar testing, follow the disposable-calendar acceptance
checklist in [docs/operations.md](docs/operations.md#manual-acceptance-with-test-calendars).

The pure sync engine lives in `packages/engine`; Google, storage, CLI, MCP, and
web adapters live in `apps/cli`. Keep event contents out of logs and preserve
tenant isolation. Include regression tests for behavior changes and describe
how you validated your pull request.

Never include OAuth credentials, tokens, signed onboarding links, calendar
contents, or local state databases in issues, patches, or test fixtures. Report
security vulnerabilities privately through GitHub's **Report a vulnerability**
option if the repository has it enabled; do not post exploit details or secrets
in a public issue.

Contributions are covered by the repository's [MIT license](LICENSE).
