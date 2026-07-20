# Security Policy

## Supported versions

Security fixes are provided for the latest published Signify Creator release.
Operators must remain on that release and apply critical fixes promptly.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately
through GitHub Security Advisories for `ithealthtech/Signify-Suite`, including
the affected version, reproduction steps, impact, and any proof of concept.
Do not access customer data, disrupt service, or retain data encountered during
testing.

The maintainers target acknowledgement within two business days, initial
severity assessment within five business days, and coordinated disclosure after
a fix is available. A report may take longer when provider coordination is
required. There is no bug-bounty promise unless separately agreed in writing.

## Release security

Release candidates must pass formatting, lint, tests, secret scanning,
dependency audit, SBOM verification, immutable-artifact checks, and production
startup. Published archives require a SHA-256 checksum and GitHub build
provenance attestation. Production deployment requires successful staging and
the protected production environment approval described in `DEPLOYMENT.md`.

Never commit credentials or customer data. Revoke and rotate any credential
that may have been exposed; deleting it from Git history is not sufficient.
