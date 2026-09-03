# Contributing

Signify Creator is source-visible commercial software. Public repository access does not
grant redistribution, resale, or commercial rights. Contributions are still welcome —
defect reports especially — but please read this first.

## Before you start

- **Security defects never go in a public issue.** Report them privately through GitHub
  Security Advisories. See [SECURITY.md](SECURITY.md).
- Open an issue before writing code for anything beyond a doc fix or a contained bug fix.
- Never include passwords, setup tokens, API keys, customer data, or screenshots containing
  secrets in an issue or pull request.

## Setup

Node.js 22.13 or newer (24 LTS recommended) and npm 10 or newer.

```bash
npm ci
npm run setup
npm run dev
```

`npm run setup` runs first-time interactive configuration and creates the first Application
Owner. The dev server listens on <http://127.0.0.1:4173>.

> **Port conflict:** this port is shared with the Northstar client portal. Do not run both
> dev servers at once.

## Before opening a pull request

```bash
npm run check
npm audit --omit=dev
```

`npm run check` is the full maintainer gate and runs, in order: `format:check`, `lint`,
`typecheck`, `test:security`, the test suite, `test:sbom`, `build`, the artifact test, and
artifact startup. All of it must pass.

For a faster loop while working:

```bash
npm run lint
npm run test:unit      # or any single test:<name> script
npm run format         # prettier --write .
```

`format:check` runs `prettier --check .` across the whole repository, so **documentation
changes must be prettier-clean too**. Run `npm run format` if it complains.

## Architecture constraints

These are properties the product depends on. A change that breaks one needs a deliberate
decision, not a passing test.

1. **Single host, single writer.** SQLite backs the application, and it supports one
   application server plus one worker. Never introduce an assumption that multiple replicas
   can run, and never write code that would have two processes writing the same database.
2. **Job processing runs embedded or as a separate worker** depending on `config.jobMode`.
   New background work must function under both.
3. **Community Edition must stay fully usable without a license.** One workspace, up to ten
   users. Licensing gates additional tenants and users, not the core editor.
4. **Losing a license degrades, it does not destroy.** If a license expires or is revoked,
   existing data stays available and the installation returns to Community limits.
5. **The License Authority is a separate deployment.** Signify Creator validates against it
   using `publicKey` and `authorityUrl` from `suite-license-config.json`. Never share an
   `.env.local` between the two projects, and never assume the authority is reachable.
6. **Signature output must stay Outlook-friendly.** Outlook's rendering engine is the
   constraint that makes this product hard. Modern CSS that breaks it is a regression even
   if it looks correct in a browser.
7. **Secrets never reach the client.** Provider credentials, setup tokens, and encryption
   keys stay server-side.

## Tests

Add coverage with behavior changes. The suite is composed of roughly 25 `test:*` scripts —
run the targeted one while developing and the full `npm run check` before opening a pull
request.

Security-relevant changes should extend `npm run test:security` rather than relying on the
general suite.

## Commits and pull requests

- Imperative subject line, under ~72 characters.
- Explain _why_ in the body; the diff already shows what.
- One logical change per pull request.
- Note which of the seven architecture constraints above your change touches, if any.
- Update [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Documentation

There are two documentation surfaces, and they have different jobs:

- **[`docs/pages/`](docs/pages/)** is the published operator and end-user guide at
  <https://ithealthtech.github.io/Signify-Suite/> — installation, configuration, usage,
  administration, troubleshooting. Detailed how-to belongs here, not in the README.
- **Root and `docs/`** hold maintainer and policy documents: deployment, operations,
  observability, licensing, privacy, retention, incident response.

The README is an entry point. Resist growing it back into an installation manual — that
content belongs in the installation guide, where it is verified.

Pages are Jekyll-built and CI-checked: every `docs/pages/*.md` file needs front matter with
`layout: default`, and `scripts/pages-test.cjs` verifies required pages, front matter, and
that internal links and assets resolve. Run it locally:

```bash
node scripts/pages-test.cjs
```
