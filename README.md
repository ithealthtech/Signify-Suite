# Signify Creator

**Create, manage, and deploy professional email signatures from one self-hosted web
application.**

[Documentation](https://ithealthtech.github.io/Signify-Suite/) |
[Install](https://ithealthtech.github.io/Signify-Suite/Installation) |
[Latest release](https://github.com/ithealthtech/Signify-Suite/releases/latest) |
[Report a problem](https://github.com/ithealthtech/Signify-Suite/issues)

Signify Creator gives organizations a visual signature editor, reusable templates, campaign
banners, approvals, Microsoft 365 delivery, analytics, and centralized management. It runs
on your own Node.js hosting, so your organization controls the application and its data.

![Signify Creator visual signature studio](docs/images/signify-studio.png)

## What you get

- A visual email signature editor with Outlook-friendly output
- Reusable templates, branding, QR codes, vCards, and campaign banners
- Three access levels: Application Owner, Tenant Admin, and End User
- Microsoft 365 tenant connections and managed signature delivery
- User management, direct user creation, invitations, and approvals
- Trial and subscription controls managed by the Application Owner
- GitHub release checks and one-click updates on supported hosts
- Built-in backups, restore tools, audit history, health checks, and usage reports
- Responsive pages for desktop, tablet, and mobile browsers

### Workspace management

See user capacity, templates, campaigns, tracked clicks, and rollout readiness in one
workspace view.

![Signify Creator workspace overview](docs/images/signify-workspace.png)

### Simple integration setup

Application Owners connect each optional service from a focused integration gallery instead
of working through one long settings page.

![Signify Creator integration gallery](docs/images/signify-integrations.png)

## Editions

Every new installation starts in **Community Edition**. No license key is required.

|                      | Community | Licensed           |
| -------------------- | --------- | ------------------ |
| Workspaces           | One       | Additional tenants |
| Users                | Up to 10  | Expanded           |
| Editor and templates | Full      | Full               |
| Campaigns            | Yes       | Yes                |
| Tenant creation      | No        | Yes                |
| Licensed features    | —         | Unlocked           |

A commercial license is entered in **Application > Licensing** — no command-line work
required. If a license expires or is revoked, existing data remains available and the
installation returns to its allowed Community limits.

See [Licensing and edition rules](docs/LICENSING.md).

## Before you install

- Node.js 22.13 or newer (Node.js 24 LTS recommended)
- npm 10 or newer
- A domain with HTTPS for production use
- A persistent folder that is not erased when the app restarts or updates
- An email address for the first Application Owner

Microsoft 365, Stripe, transactional email, and GitHub are optional. Connect them later from
**Application > Integrations**.

> **Single-host only.** Signify uses SQLite and supports one application server and one
> worker on a single host. Do not run multiple application replicas, and never point two web
> servers at the same SQLite database.

## Install

Three supported paths — Node.js web hosting, the interactive installer, and Docker Compose —
are documented in full, with hosting-specific settings, in the
**[installation guide](https://ithealthtech.github.io/Signify-Suite/Installation)**.

For a quick local trial:

```bash
npm ci
npm run setup
npm run dev
```

`npm run setup` walks through first-time configuration and creates the first Application
Owner.

Deployment and hosting specifics are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Everyday operation

| Task                                       | Where                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| First-time setup and connecting services   | [Configuration guide](https://ithealthtech.github.io/Signify-Suite/Configuration)               |
| Building signatures, templates, campaigns  | [Using Signify Creator](https://ithealthtech.github.io/Signify-Suite/Using-Signify-Creator)     |
| Licensing, tenants, subscriptions, updates | [Application Owner guide](https://ithealthtech.github.io/Signify-Suite/Application-Owner-Guide) |
| Something is broken                        | [Troubleshooting](https://ithealthtech.github.io/Signify-Suite/Troubleshooting)                 |

## Validate an installation

Run the health check after installing or updating:

```bash
npm run doctor
```

The application also exposes:

```text
GET /api/live    Is the application process running?
GET /api/ready   Are the database and required services ready?
GET /api/health  Compatibility health check
```

Maintainers run the full validation suite:

```bash
npm run check
npm audit --omit=dev
```

`npm run check` covers formatting, lint, type checking, security tests, the test suite, SBOM
verification, the build, and artifact startup. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Safety notes

- Always use HTTPS in production.
- Keep `.env.local`, provider secrets, setup tokens, and encryption keys private.
- Never commit production credentials or customer data.
- Keep the database, media, and backups on persistent storage.
- Require MFA for Application Owners.
- Create a backup before installing updates.

## Administrator guides

| Operating                                                    | Policy                                         |
| ------------------------------------------------------------ | ---------------------------------------------- |
| [Deployment and hosting](DEPLOYMENT.md)                      | [Security policy](SECURITY.md)                 |
| [Operations, provider testing, recovery](docs/OPERATIONS.md) | [Privacy and data handling](docs/PRIVACY.md)   |
| [Monitoring and alerts](docs/OBSERVABILITY.md)               | [Data retention](docs/DATA-RETENTION.md)       |
| [Licensing and edition rules](docs/LICENSING.md)             | [Incident response](docs/INCIDENT-RESPONSE.md) |

## Release status

The current stable version is
[v1.1.0](https://github.com/ithealthtech/Signify-Suite/releases/tag/v1.1.0). Read the
release notes before updating. GitHub source archives are available on the release page. A
signed one-click installation package is published only after the production License
Authority identity and release checks pass.

See [CHANGELOG.md](CHANGELOG.md).

## Support

Use [GitHub Issues](https://github.com/ithealthtech/Signify-Suite/issues) for verified
defects. Never include passwords, setup tokens, API keys, customer data, or screenshots
containing secrets.

Report suspected vulnerabilities privately — see [SECURITY.md](SECURITY.md), not a public
issue.

## Licensing and access

Signify Creator is source-visible software. Public repository access does not include the
private Signify License Authority and does not grant redistribution, resale, or commercial
rights beyond those provided by the repository owner and the active Signify license.
