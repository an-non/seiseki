# SEISEKI production preflight

Generated from branch: feature/quantum-app-integration
GitHub head: 23cbb623c5bffad85f252e22f8024532b9f1bbef

## Application
- app tests: passed
- Cloudflare worker tests: passed
- typography patch: Hiragino-first, external Google Fonts removed
- quantum glow experiment: archived separately; stable renderer selected

## Production configuration
- configured D1 id: 00000000-0000-0000-0000-000000000000
- remote D1 named seiseki-db discovered: false
- remote D1 id: not-found
- production ALLOWED_ORIGINS: configured
- production AI binding: missing
- production queue discovered: true
- Turnstile widget visible to deployment token: unknown

## Security gates
- Turnstile server-side verification exists for response submission.
- Production must not set TURNSTILE_REQUIRED=true until a client sitekey/token flow is present.
- Account login/register currently have no dedicated application-level rate limiter.
- Bearer sessions are random 32-byte tokens stored server-side only as SHA-256 hashes.
- CORS uses an explicit origin allowlist when ALLOWED_ORIGINS is configured.
- Request JSON is limited to 32 KiB; free text is limited to 1500 characters.

## Deploy decision
BLOCKED: production configuration is incomplete. Do not deploy until D1 and origin configuration are finalized.
