# Subprocessor Inventory

The operator must replace conditional entries with the actual contracted
providers, locations, purposes, and transfer safeguards before production and
notify customers as required by contract.

| Provider/category                                | Purpose                                      | Data involved                                       | Required operator evidence                 |
| ------------------------------------------------ | -------------------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| Hosting provider                                 | Web/worker compute and network               | Application traffic and runtime data                | contract, region, security terms           |
| Managed PostgreSQL or persistent volume provider | Primary data storage                         | Tenant/account/product data                         | encryption, backups/PITR, region           |
| S3-compatible storage/recovery provider          | Private media and recovery                   | Tenant media and encrypted recovery copies          | versioning, encryption, lifecycle, region  |
| Microsoft Azure/Graph                            | Tenant consent, directory, and mail          | Microsoft tenant identity/directory/mail content    | publisher verification, permissions, terms |
| Stripe                                           | SaaS billing controlled by Application Owner | Commercial account and subscription metadata        | DPA, webhook/test/live controls            |
| Email provider, when configured                  | Transactional delivery                       | Recipient, subject, message content                 | DPA, region, suppression handling          |
| Telemetry provider, when configured              | Logs, metrics, alerts                        | Redacted operational diagnostics                    | DPA, retention, access controls            |
| GitHub                                           | Source, CI, release provenance               | Source and build metadata; no customer runtime data | organization security and access review    |

Do not send PHI, credentials, raw provider tokens, session identifiers, or
customer message bodies to diagnostic telemetry. Adding a provider requires a
security/privacy review and inventory update before production use.
