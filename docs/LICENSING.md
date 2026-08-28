# Signify licensing

## Editions

| Right                                 | Community                            | Enterprise                             |
| ------------------------------------- | ------------------------------------ | -------------------------------------- |
| Tenant workspaces                     | 1                                    | Signed `maxTenants` entitlement        |
| Users and managed signatures          | 10                                   | Signed `maxUsersPerTenant` entitlement |
| Signature editor and campaigns        | Included                             | Included                               |
| Microsoft 365 tenant connection       | Included for the installation tenant | Included for licensed tenants          |
| Multi-tenant control plane            | Capacity locked                      | Included                               |
| Stripe tenant billing                 | Not available                        | Requires `tenant_billing` entitlement  |
| Application updates and backups       | Included                             | Included                               |
| Product support and commercial rights | Community terms                      | Commercial agreement                   |

Community is the permanent default and does not require a key. Its Application
page manages the installation's single workspace instead of exposing the tenant
portfolio. A downgrade never deletes tenants, users, or signatures. When tenant
or user usage exceeds the current entitlement, existing data remains accessible,
but every server-side tenant, invitation, directory-sync, and direct user creation
path is blocked.

## Customer activation

An Application Owner opens **Application > Licensing**, copies the installation
ID, and enters the activation key supplied with the subscription. No shell access
is required. The installation exchanges the activation key with the Signify
license authority, verifies the returned Ed25519 signature locally, and stores the
signed entitlement.

The owner screen can refresh the entitlement immediately or return the instance to
Community. Signify refreshes commercial entitlements automatically every 12 hours
by default. If the authority is unavailable, the last signed entitlement remains
valid until its displayed grace deadline. An authoritative revoked or suspended
response downgrades the installation immediately and is remembered locally so an
old token cannot be replayed.

Stripe is fail-closed and Enterprise-only. Its integration, tenant subscription
controls, checkout, portal, webhook processing, and reconciliation are available
only while the active signed license has both `edition: enterprise` and the
`tenant_billing` feature. Stored provider credentials are retained during a
downgrade but are not exposed or used until an eligible license is restored.

## Trust boundary

Customer installations receive only:

- the public Ed25519 license verification key;
- the HTTPS authority URL;
- signed, installation-bound entitlement tokens.

The private signing key, authority admin token, central Stripe key, and Stripe
webhook secret exist only in the separately deployed creator authority. Never copy
those secrets into a customer installation or a release artifact.

## Authority deployment

Deploy the separately supplied private **Signify License Authority** package
behind HTTPS with persistent storage. Authority source, signing material, and
administration tools are intentionally excluded from the public Signify Suite
repository and customer release artifacts. Register this central Stripe webhook:

```text
https://license.your-domain.example/webhooks/stripe
```

Map exact Stripe Price IDs, `maxTenants`, and `maxUsersPerTenant` values in
`SIGNIFY_AUTHORITY_STRIPE_PRODUCTS_JSON`. The
authority accepts `customer.subscription.*` events, verifies Stripe signatures,
deduplicates event IDs, and converts the mapped price and subscription state into
installation rights. `active` and `trialing` subscriptions can receive signed
leases; suspended, unpaid, expired, or revoked records cannot refresh.

Creator-only authority routes require the 32+ character bearer token:

- `GET /v1/admin/licenses`
- `POST /v1/admin/licenses`
- `POST /v1/admin/licenses/{id}/rotate-activation`
- `POST /v1/admin/licenses/{id}/revoke`

Public installation routes accept only activation or previously signed license
material and never expose authority secrets:

- `POST /v1/licenses/activate`
- `POST /v1/licenses/refresh`

## Signed releases

Published GitHub releases require a separate Ed25519 release-signing key. The
workflow signs `checksums.txt`, verifies the detached signature before packaging,
and deploys only the signed artifact. Hosts set
`SIGNIFY_RELEASE_SIGNING_PUBLIC_KEY` and leave
`SIGNIFY_DEPLOY_REQUIRE_SIGNATURE=true` so the updater rejects unsigned or altered
packages.
