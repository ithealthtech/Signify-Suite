# Optimization Baseline

Run `npm run benchmark` on the same host before and after structural or runtime
optimization work. The command rebuilds the production artifact, runs the setup
and smoke suites independently, measures application initialization and 100
health requests, and writes `docs/performance-baseline.json`.

## Initial findings

- `server/signature-portal.cjs` owns 5,666 lines and 196,283 bytes of routes,
  authorization, provider integration, persistence, and rendering behavior.
- `scripts/smoke-test.cjs` owns 1,923 lines and 65,472 bytes in one test process.
- The three browser applications repeat API request, error, notification, and
  session behavior across 93,381 bytes of JavaScript.
- The three style sheets total 55,761 bytes and repeat shell, form, button,
  dialog, and responsive rules.
- The clean production artifact is 13,520,982 bytes with 63 non-development
  dependency package entries.

## Acceptance rules

- Every optimization phase must keep `npm run check` and the security smoke
  coverage passing.
- Changes to startup, request handling, dependencies, or artifact composition
  must include before-and-after benchmark evidence from the same host.
- Performance regressions greater than 10 percent require a documented product
  or reliability tradeoff.
- Structural consolidation must preserve the three access levels, tenant data
  isolation, Microsoft consent, owner-only Stripe controls, and all visible
  signature and campaign workflows.
