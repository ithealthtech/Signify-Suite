# OWASP ASVS Security Review

This review uses OWASP ASVS 4.x Level 2 as the application baseline. It is an
engineering control record, not an external certification. Re-review it for
every material authentication, authorization, storage, provider, or deployment
change.

| Area               | Implemented evidence                                                                             | Verification                                        |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Architecture       | Modular monolith, three-tier policy layer, tenant IDs on customer records                        | access-control and cross-tenant smoke tests         |
| Authentication     | Password hashing, email verification/reset, bounded sessions, owner TOTP and recovery codes      | unit, MFA, expiration, replay, and smoke tests      |
| Session management | HttpOnly/Secure/SameSite cookies, CSRF, revocation, device history, short owner sessions         | auth-security and privileged-session tests          |
| Access control     | Application Owner, Tenant Admin, End User; server-side resource/tenant checks                    | denied-role and cross-tenant API tests              |
| Validation         | Structured JSON/body limits, field normalization, safe URLs, image decoding                      | unit, malformed request, XSS-like, and upload tests |
| Cryptography       | AES-256-GCM credential vault, key rotation, hashed one-time tokens, TLS-required production URLs | credential rotation and startup validation tests    |
| Errors/logging     | Stable error shapes, request/trace IDs, secret redaction, separate audit records                 | observability and smoke tests                       |
| Data protection    | Private S3 objects, tenant prefixes, quotas, signed reads, encrypted/versioned recovery          | media and recovery tests                            |
| Communications     | HTTPS public URL required, HSTS, CSP, secure proxy policy, provider timeouts                     | production setup and artifact-startup tests         |
| Malicious input    | CSP, output escaping, SQL parameters, path containment, upload type/size validation              | static review and security smoke tests              |
| Business logic     | Idempotent Stripe webhooks, durable jobs, exact destructive confirmation, step-up auth           | billing, lifecycle, job, and smoke tests            |
| Files              | Explicit artifact allowlist, no runtime/customer files, checksums, MIME/image validation         | artifact and media tests                            |
| API                | Authentication, role/tenant authorization, CSRF, rate limits, consistent status/error contracts  | API smoke suite                                     |
| Configuration      | Production fail-closed settings, encrypted secrets, secret scan, no populated artifact secrets   | setup, secret-scan, and artifact tests              |

Open external evidence remains: independent penetration testing, live provider
acceptance, target-host hardening review, and healthcare/PHI assessment when an
operator intends to serve a regulated workflow.
