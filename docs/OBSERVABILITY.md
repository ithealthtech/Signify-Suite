# Observability And Incident Operations

Diagnostic telemetry must never contain passwords, cookies, authorization
headers, session identifiers, provider credentials, or tokens. Signify redacts
matching fields before local JSON output and before optional HTTPS export.
Application and tenant audit tables remain the authority for administrative
history and use a separate retention policy.

## Service objectives

Measure these over a rolling 30-day window, excluding announced maintenance:

| Indicator          | Objective                          | Alert gate                               |
| ------------------ | ---------------------------------- | ---------------------------------------- |
| HTTPS availability | 99.9% successful readiness probes  | Two failed probes over two minutes       |
| API server errors  | Fewer than 0.5% HTTP 5xx responses | Configured rolling sample reaches 5%     |
| API latency        | 95% of requests below 500 ms       | p95 above 1 second for 10 minutes        |
| Durable jobs       | 99% start within five minutes      | Oldest queued job reaches five minutes   |
| Recovery           | RPO 24 hours; RTO four hours       | Backup, restore, or recovery drill fails |

The built-in process alert uses `SIGNIFY_ALERT_MIN_REQUESTS`,
`SIGNIFY_ALERT_ERROR_RATE`, `SIGNIFY_ALERT_QUEUE_AGE_SECONDS`, and
`SIGNIFY_ALERT_COOLDOWN_SECONDS`. The external monitor owns readiness, p95,
host, database, object-storage, and backup alerts because an unavailable process
cannot notify on its own.

## Dashboards and paging

Scrape `GET /api/metrics/prometheus` over a private monitoring route or send
events through `SIGNIFY_OBSERVABILITY_ENDPOINT`. The primary dashboard must
show request volume/error/latency, readiness, queue depth and age, dead letters,
Microsoft/Stripe errors, process memory, database/storage capacity, backup age,
and release version. Configure the collector to page on `operational.alert`
events with `critical` severity and route warnings to the operations queue.

## Incident severity

| Severity | Definition                                                           | Response target                             |
| -------- | -------------------------------------------------------------------- | ------------------------------------------- |
| SEV-1    | Broad outage, active data exposure, or unrecoverable customer writes | Page immediately; acknowledge in 15 minutes |
| SEV-2    | Major tenant workflow unavailable or sustained provider/job failure  | Acknowledge in 30 minutes                   |
| SEV-3    | Degraded noncritical behavior with a workaround                      | Triage next business day                    |

The on-call owner validates `/api/live` and `/api/ready`, checks the release and
queue dashboards, records an incident timeline, contains unsafe writes, and
uses the recovery or rollback runbook. Security incidents also follow
`docs/SECURITY.md` when present. Never paste secrets or customer content into an
incident channel.

## Status communication

For SEV-1 and customer-visible SEV-2 incidents, publish an initial status update
within 30 minutes, update at least hourly, and close with impact, duration, and
recovery confirmation. Publish a blameless review within five business days for
SEV-1. The status page must be hosted independently from Signify.

## Retention

Keep high-volume diagnostic logs for 30 days and aggregated metrics for 13
months unless contractual requirements differ. Restrict diagnostic access to
operations personnel and review it quarterly. Keep administrative audit and
billing records according to the documented legal/data-retention policy; do not
delete them through telemetry retention jobs.
