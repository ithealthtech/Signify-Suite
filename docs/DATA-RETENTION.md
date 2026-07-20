# Data Retention And Deletion

The SaaS operator is the controller for account, billing, support, and
application-operations data and a processor for tenant signature content and
directory data, subject to the executed customer agreement.

| Data class                              | Default retention             | Disposal                                              |
| --------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| Active tenant product data              | Contract term                 | Delayed, cancelable tenant deletion workflow          |
| Deleted tenant lifecycle/audit evidence | Seven years                   | Authorized database retention job or legal process    |
| Billing and subscription records        | Seven years                   | Authorized financial retention process                |
| Administrative and tenant audit logs    | Seven years                   | Authorized retention process; never telemetry cleanup |
| Diagnostic logs                         | 30 days                       | Collector lifecycle policy                            |
| Aggregated operational metrics          | 13 months                     | Metrics-store lifecycle policy                        |
| Database recovery points                | 30 days, minimum seven copies | Automated local/off-site retention                    |
| Unreferenced media                      | Seven days                    | Durable maintenance job                               |
| Sessions and one-time tokens            | Until expiry/use              | Durable maintenance job                               |

Legal hold overrides deletion. An Application Owner must verify requester
authority, export data when required, record the reason, and use the product's
tenant lifecycle control. Recovery copies age out according to policy; they are
not edited in place. Restored data must immediately re-enter the deletion queue
when a valid deletion request remains applicable.

Operators must document jurisdiction-specific requirements and customer
contract overrides before launch. This policy does not by itself establish
HIPAA, GDPR, or other regulatory compliance.
