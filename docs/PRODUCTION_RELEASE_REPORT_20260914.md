# SEISEKI production release report

- Date: 2026-09-14
- Source branch: `codex/production-rc-prep-20260914`
- Deployed source commit: `e40acc168839f0ba1820489c6bc61518a4263540`
- Production Worker version: `525586ec-dfa1-4b33-b327-ac94911ec133`
- Production URL: `https://seiseki-api.tokyo-odh-129.workers.dev`

## Acceptance evidence

- Staging current-response E2E passed, including registration, initial response,
  follow-up analysis, initial-response correction, stale revision rejection,
  follow-up withdrawal, reanalysis, account cleanup, and aggregate restoration.
- Application and Worker tests passed in GitHub Actions before the release gate.
- Production assets build passed with 602 modules transformed.
- Production runtime asset contract and Wrangler dry-run passed.
- Production quantum-v2 local prototype assets were excluded.

## Production D1

- Preflight duplicate account-response ownership groups: `0`
- Preflight and postflight foreign-key violations: `0`
- Recovery bookmark before migration:
  `0000006a-00000000-000050e6-ebc6ef24e373936150fe240855e9b3cc`
- Applied migrations: `0009_analysis_cache.sql` through
  `0012_short_submission_fingerprints.sql`
- Pending migrations after apply: `0`
- Existing row counts observed after migration: accounts `2`, responses `102`

## Production secrets

The following HMAC secrets were generated with a cryptographic random-number
generator and configured without logging or storing their values:

- `ANALYSIS_CACHE_HMAC_SECRET`
- `SUBMISSION_FINGERPRINT_HMAC_SECRET`
- `RATE_LIMIT_FINGERPRINT_SECRET`

An initial PowerShell-incompatible random generation attempt created unusable
values. They were replaced before the new Worker code was deployed. The final
active secret-change version before code deployment was
`24249d70-9167-45c9-b676-89eb95463f70`.

## Release path and remaining operations issue

GitHub Actions runs `34820431077` and `34820641724` stopped before deployment.
The first exposed a workflow ordering defect and was corrected. The second
showed that the repository's `CLOUDFLARE_API_TOKEN` cannot authenticate to the
configured production account. The pushed immutable source commit was therefore
built, checked, dry-run, and deployed with the locally authenticated Wrangler
client. Repairing the GitHub Actions Cloudflare credential remains an operations
task; it does not affect the active Worker runtime.

## Read-only production smoke

- `/api/health`: HTTP 200, `status=ok`, `database=d1`
- `/api/config`: HTTP 200
- `/app`: HTTP 200, HTML served
- `/app/quantum`: HTTP 200, HTML served

No production test response was submitted and no existing production row was
deleted during release verification.
