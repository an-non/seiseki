# SEISEKI

Canonical GitHub repository for the SEISEKI project.

## Deployment safety

This repository is intentionally initialized **without automatic Cloudflare deployment**.

Branches:
- `main`: repository bootstrap / coordination only; not a deployment branch.
- `production`: intended production branch; must not deploy until production Cloudflare resources are explicitly connected and validated.
- `staging`: intended pre-production branch; must not deploy until the imported source is verified against the existing Cloudflare staging configuration.
- `import/seiseki-v0.15.0`: initial import and reconciliation branch for the preserved SEISEKI source package.

Initial reconciliation rules:
1. Import only `seiseki-project/`; do not import sibling projects.
2. Do not run D1 migrations automatically.
3. Do not modify existing Cloudflare staging resources during repository bootstrap.
4. Verify `cloudflare/wrangler.jsonc`, migrations, tests, and build output before enabling any deploy workflow.
5. Production remains disconnected until its D1/Worker resources are explicitly created and confirmed.
