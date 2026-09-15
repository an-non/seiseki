# SEISEKI GitHub / Cloudflare deployment safety plan

## Current repository role

This repository is being bootstrapped from the preserved `seiseki-project/` package.

Branches:
- `main`: bootstrap/coordination only. No Cloudflare deployment.
- `production`: reserved for production. No deployment until production resources are explicitly connected and validated.
- `staging`: reserved for pre-production. No deployment until the imported source is reconciled with the existing Cloudflare staging state.
- `import/seiseki-v0.15.0`: initial source import and reconciliation branch.

## Preserved source baseline

The preserved SEISEKI-only archive is expected to contain only `seiseki-project/` and no sibling project directories.

Verified archive metadata from the handoff package:
- Files: 13,116
- Directories: 1,925
- Symlinks: 0
- Reassembled ZIP SHA-256: `b51e8f9bb0a5751d2ffa40b7b9a77cf25ed48e6ad4ffb1c24c33a489c927fcd5`

## Known Cloudflare staging baseline

Do not treat these values as a live remote check; they are the preserved deployment baseline that must be reconciled before deployment.

- Worker: `seiseki-api-staging`
- D1: `seiseki-db-staging`
- Staging D1 ID: `64468050-a8e5-4a5f-86a7-3dfca661df55`
- Queue: `seiseki-analysis-staging`
- Workers AI model: `@cf/qwen/qwen3-30b-a3b-fp8`
- `AI_MAX_ATTEMPTS`: 2
- Recorded staging Worker version: `cc003855-cdee-41c2-b928-985b4fe6466a`

Known migrations:
- `0001_initial.sql`
- `0002_accounts_and_analysis.sql`
- `0003_staging_kdf_range.sql`
- `0004_response_question_context.sql`

Production D1 is not considered connected while its configured database ID remains the all-zero placeholder.

## Non-conflict rules

1. Import source only to `import/seiseki-v0.15.0` first.
2. Do not push imported source directly to `staging` or `production`.
3. Do not create an automatic push-triggered Cloudflare deployment during bootstrap.
4. Do not run D1 migrations as part of normal Worker/static deployment.
5. Reconcile `cloudflare/wrangler.jsonc`, migration files, test suite, and build output against the preserved staging baseline before enabling deployment.
6. Initial Cloudflare staging deployment must be manual and explicitly target `seiseki-api-staging` only.
7. Production remains disconnected until separate production Worker/D1 resources are created and confirmed.
8. DNS permissions are not required for the existing `workers.dev` deployment path.

## Promotion sequence

`import/seiseki-v0.15.0` -> verify source/tests/build -> PR to `staging` -> manual staging deploy -> verify remote -> later PR to `production` only after production resources exist.

D1 changes use a separate migration workflow: staging migration -> validation -> explicit production migration. Never bundle D1 migration into ordinary deploy.
