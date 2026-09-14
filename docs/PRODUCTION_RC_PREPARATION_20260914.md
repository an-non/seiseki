# SEISEKI production RC preparation

- Date: 2026-09-14
- Branch: `codex/production-rc-prep-20260914`
- Scope: release reproducibility, production workflow isolation, and password KDF alignment
- Production deployment, production D1 migration, production secret changes, and GitHub push: not performed

## Current external state observed before preparation

- Staging Worker version: `eb3601b9-59ab-4131-8eec-66d010710cc7`
- Production Worker version: `9900ca8a-72c0-4186-87e9-632732235d2e`
- Production D1 pending migrations: `0009_analysis_cache.sql` through `0012_short_submission_fingerprints.sql`
- Production secrets required by the new optional controls were not configured.
- Production Queue and DLQ already existed.

## Release safety changes

- The production release workflow accepts only a full approved commit SHA and an explicit confirmation string.
- The workflow uses `contents: read`, disables checkout credentials, and does not commit or push.
- Production D1 migration is not performed by the Worker release workflow.
- A separate manual D1 migration workflow records a Time Travel bookmark before applying migrations.
- The release workflow refuses deployment while production migrations or required HMAC secrets are missing.
- The local-only quantum-node relations v2 prototype remains available in local and staging builds but is excluded from production assets.

## Password KDF decision

PBKDF2-HMAC-SHA-256 was measured locally seven times per profile:

| Iterations | Minimum | Median | Maximum |
| ---: | ---: | ---: | ---: |
| 30,000 | 3.93 ms | 4.73 ms | 6.01 ms |
| 100,000 | 14.12 ms | 15.75 ms | 18.45 ms |
| 120,000 | 16.90 ms | 18.35 ms | 19.34 ms |

The historical Cloudflare Free execution failure at 120,000 iterations and the successful staging registration profile at 30,000 iterations support using 30,000 for the current no-paid-plan release. D1-backed login, registration, and recovery rate limits remain required compensating controls. A stronger KDF profile requires a larger Worker CPU allowance or an external identity provider.

## Verification performed

- Application tests: 55 passed
- Page routing tests: 9 passed
- Local model bridge tests: 9 passed
- Quantum engine tests: 10 passed
- Runtime deployment contract tests: 7 passed
- Cloudflare Worker tests: 116 passed
- Production Vite build: passed, 602 modules transformed
- Production runtime artifact contract: passed
- Production quantum v2 exclusion: passed
- `git diff --check`: passed

## Explicitly skipped

The full staging live E2E suite was intentionally skipped at the user's request. Before production deployment, this remains a known acceptance gap rather than an inferred pass.
