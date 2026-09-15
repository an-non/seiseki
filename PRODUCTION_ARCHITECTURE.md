# SEISEKI production architecture

## Release scope

This document fixes the production boundary for the deadline release. It is intentionally narrower than the future product architecture.

## 1. Browser application

The React/Vite application is served by the `seiseki-api` Cloudflare Worker as static assets.

Runtime modes are explicit:

- `local`: no Cloudflare persistence is required.
- `staging`: connects to `seiseki-api-staging` and shows the staging warning banner.
- `production`: connects to `seiseki-api` and does not show the staging warning banner.

Japanese UI typography uses a Hiragino-first system stack. External Google Fonts are not required for the release.

## 2. Production API Worker

Worker: `seiseki-api`

Responsibilities:

- serve application assets;
- validate and store questionnaire responses;
- account register/login/session/update/delete;
- expose public aggregate/config/demo endpoints;
- enqueue answer analysis;
- expose completed analysis results.

The production API Worker is the only component in this release that receives a production D1 binding.

## 3. D1

Production database: `seiseki-db`

Stored data includes:

- submitted responses and answer selections;
- optional demographic fields selected by the respondent;
- free text;
- consent metadata;
- account records and hashed sessions;
- analysis state/results and opinion chunks;
- short-lived application rate-limit counters.

Raw client-supplied analysis/nodes are not trusted as authoritative analysis output.

## 4. Workers AI and Queue

Queue: `seiseki-analysis`

A successful response submission is stored first. Analysis is then dispatched through the queue when Workers AI analysis is enabled. Queue failure falls back to Worker background analysis where supported by the current implementation.

The queue/AI pipeline concerns response analysis only. It is not used by the quantum visualization in this release.

## 5. Quantum observation

Worker: `seiseki-opinion-network-preview`

For the deadline release the quantum screen is a synthetic/demo visualization only.

- it renders the current deterministic prototype dataset;
- it does not read production D1;
- it does not receive D1, AI, account, or session bindings;
- the production application embeds it as a separate-origin iframe;
- the relation-glow experiment is archived at `archive/quantum-relation-glow-20260823` and is not part of the stable release renderer.

Future database-backed quantum visualization must be introduced through an explicit read API that returns privacy-reviewed aggregate/derived data. Direct D1 access from the visualization Worker is not part of this release.

## 6. Turnstile

The server supports Turnstile verification, but the release browser does not yet obtain a Turnstile token.

Release behavior:

- `TURNSTILE_REQUIRED=false`;
- no token: request is allowed;
- optional token + configured secret: token is verified;
- future `TURNSTILE_REQUIRED=true`: allowed only after the browser widget/site-key/token flow is implemented and verified end-to-end.

The public site key may be exposed to the browser. `TURNSTILE_SECRET` must remain a Worker secret and must never be committed.

## 7. Application rate limits

Because Turnstile enforcement is disabled for the first production release, the Worker applies D1-backed limits before expensive authentication or write operations.

Initial limits:

- login: 10 attempts/minute and 60/hour per network fingerprint; also 10/minute per account-name fingerprint;
- register: 5 attempts/10 minutes and 20/day per network fingerprint;
- response submission: 20 submissions/10 minutes and 100/day per network fingerprint.

The database stores SHA-256 fingerprints, not raw IP addresses. Rate-limit rows are operational security metadata and may be periodically deleted after their windows expire.

These limits are abuse controls, not identity guarantees and not a replacement for Turnstile.

## 8. CORS and browser/API boundary

Production CORS allowlist is restricted to the production application origin. Staging keeps its own allowlist.

Requests carrying a browser `Origin` not in the environment allowlist receive 403 before routing.

## 9. Production release gates

A production release must:

1. pass application and Worker tests;
2. resolve the real production D1 ID;
3. confirm/create the production analysis queue;
4. apply all D1 migrations;
5. build assets with the production API URL and production runtime mode;
6. record the existing Worker deployment state;
7. deploy with Wrangler strict conflict protection;
8. pass `/api/health`, `/api/config`, and application smoke checks;
9. write `PRODUCTION_RELEASE.md` only after all previous gates succeed.

## 10. Deferred items

Not release blockers for the current deadline build, but explicitly deferred:

- browser Turnstile widget/token integration and enforcement;
- database-backed quantum visualization;
- dedicated custom domain if not already configured;
- stronger distributed rate limiting if traffic exceeds the D1-backed release limits;
- final public attribution/license review for all datasets/models before broad public promotion.
