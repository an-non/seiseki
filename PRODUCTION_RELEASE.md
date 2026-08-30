# SEISEKI production release

## Verified production state

- outcome: success
- production_url: https://seiseki-api.tokyo-odh-129.workers.dev
- application_url: https://seiseki-api.tokyo-odh-129.workers.dev/app
- worker: seiseki-api
- application_rc_sha: e1652c303868b9c20e476abc1888ba7388738b2f
- staging_baseline_sha: f2b9d0a6b3642f4c3b064f64c47c13726cc8127c
- worker_version: 189f988a-4928-47ba-b46c-4889ed333ed8
- d1_database: seiseki-db
- d1_database_id: 8ad5e023-3588-490c-ba61-3f180f8b2887
- analysis_queue: seiseki-analysis
- analysis_queue_id: 4606abc6f57645358bad7444b83e3b1b
- dead_letter_queue: seiseki-analysis-dlq
- dead_letter_queue_id: 229d70c5c3834fbe8ee566c0e82cf7ec
- workers_ai: enabled
- model: @cf/qwen/qwen3-30b-a3b-fp8
- password_iterations: 100000
- turnstile_required: false
- runtime_mode: production

## Verification evidence

Production release workflow:
- workflow: `.github/workflows/production-deploy-rc1-kdf-20260830.yml`
- run: 33284747335
- job: 99185874481
- result: success

Independent post-release read-only verification:
- workflow: `.github/workflows/production-postrelease-readonly-20260830.yml`
- run: 33285736138
- job: 99188515824
- result: success
- D1 identity: pass
- pending release migrations: none
- D1 duplicate ownership groups: 0
- D1 foreign-key violations: 0
- Queue/DLQ attachment: pass
- recorded Worker version visible: pass
- `/api/health`: pass
- `/api/config`: pass
- `/app`: pass

Full production E2E completed successfully during the release. It exercised temporary account creation, initial response, follow-up add/edit/withdraw, revision conflict handling, analysis, public aggregate visibility, account deletion cleanup, and aggregate restoration.

## Release architecture now considered canonical

1. prove an exact staging-tested application SHA
2. create a production RC with explicitly reviewed production-only deltas
3. run a read-only production preflight
4. apply only the exact expected D1 migrations
5. verify D1 integrity before deployment
6. dry-run the exact RC
7. deploy with Wrangler from the exact RC SHA
8. verify Queue/DLQ attachment
9. run health/config/app smoke checks
10. run the staging-proven live E2E flow against production with cleanup
11. verify post-release D1 integrity
12. run an independent read-only post-release verification

Do not use `.github/workflows/production-release.yml` as the canonical production path. It is legacy/deprecated because it mixes resource discovery/creation, configuration rewriting, commits, migrations, deployment, and smoke checks, and it references the old feature branch.

## Branch-alignment hold

The Cloudflare Workers Builds Git integration is still connected. The exact production branch trigger has not yet been independently read from Cloudflare. Therefore these branch refs are intentionally not moved yet:

- `production`
- `staging`
- `main`

Do not fast-forward those refs until the Cloudflare Worker `Settings > Build` production branch and deploy command are confirmed. This avoids an unplanned second native Cloudflare deployment.

Once the native Git trigger is confirmed safe, align the Git refs to the verified release state and then retire/deactivate the legacy production workflow on the branches from which it can still be invoked.

## Known held issue

Workers AI continues to show a strong ten-point-step tendency in raw numeric output. The release trace confirmed this occurs before sanitizer/D1/API/UI handling. This is an AI-quality issue and is intentionally separated from production infrastructure correctness.
