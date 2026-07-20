# Security Incident Response

1. **Receive and classify:** open a restricted incident record, preserve the
   reporter's evidence, assign SEV-1/2/3, and page the security owner for
   suspected data exposure or active compromise.
2. **Contain:** revoke affected sessions and credentials, suspend unsafe tenant
   or provider operations, isolate hosts, and preserve logs/snapshots. Do not
   destroy evidence to make service appear healthy.
3. **Investigate:** correlate request IDs, trace IDs, application audit events,
   provider logs, deployment provenance, and database state. Record every
   action and timestamp.
4. **Eradicate and recover:** fix the root cause, rotate secrets, validate a
   clean artifact, restore only verified recovery points, and exercise tenant
   isolation and critical workflows before returning traffic.
5. **Notify:** involve legal/privacy leadership to determine contractual and
   statutory notification deadlines. Use the independent status process for
   service impact without exposing investigation-sensitive details.
6. **Review:** publish a restricted post-incident analysis, track corrective
   actions to owners/dates, update tests/runbooks, and review effectiveness.

Maintain offline contact details for the incident commander, security owner,
hosting provider, Microsoft, Stripe, storage/backup provider, legal counsel, and
cyber insurer. Exercise a tabletop twice yearly and a technical recovery drill
at least quarterly. See `docs/OBSERVABILITY.md` for service severity and status
communication targets.
