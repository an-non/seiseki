#!/usr/bin/env bash
set -euo pipefail

# Staging contract only. No migrations and no production environment.
test -f DEPLOYMENT_SAFETY.md
test -f cloudflare/wrangler.jsonc
grep -q '"name": "seiseki-api-staging"' cloudflare/wrangler.jsonc
grep -q '"database_name": "seiseki-db-staging"' cloudflare/wrangler.jsonc
grep -q '"database_id": "64468050-a8e5-4a5f-86a7-3dfca661df55"' cloudflare/wrangler.jsonc
grep -q '"queue": "seiseki-analysis-staging"' cloudflare/wrangler.jsonc
grep -q '"AI_MODEL": "@cf/qwen/qwen3-30b-a3b-fp8"' cloudflare/wrangler.jsonc
grep -q '"AI_MAX_ATTEMPTS": "2"' cloudflare/wrangler.jsonc

test ! -e .env
test ! -e local/.env.staging
test ! -e cloudflare/.env.staging
node scripts/build-app.mjs
git diff --exit-code -- app/seiseki.jsx local/src/App.jsx

grep -q 'quantum: "/app/quantum"' core/ui.jsx
grep -q 'seiseki-opinion-network-preview.tokyo-odh-129.workers.dev' core/ui.jsx
node tests/test.js
node tests/page-routing.test.mjs
node tests/local-bridge.test.js
node tests/balcheck.js app/seiseki.jsx
node tests/quantum-entanglement-engine.test.mjs

node -e '
  const fs=require("fs"), crypto=require("crypto"), path=require("path");
  const d="local/public/model";
  const man=JSON.parse(fs.readFileSync(path.join(d,"manifest.json"),"utf8"));
  let ng=0;
  for (const f of man.files) {
    const p=path.join(d,path.basename(f.url));
    const b=fs.readFileSync(p);
    const h=crypto.createHash("sha256").update(b).digest("hex");
    const ok=h===String(f.sha256).toLowerCase() && b.length===f.bytes;
    console.log(path.basename(p)+": "+(ok?"ok":"MISMATCH"));
    if(!ok) ng++;
  }
  process.exit(ng?1:0);
'
grep -q 'takeWhole' local/public/model/model-store.js

(
  cd cloudflare
  npm ci --ignore-scripts --no-audit --no-fund
  npm run check
  npm test
)

(
  cd local
  npm ci --no-audit --no-fund
  VITE_SEISEKI_API_BASE=https://seiseki-api-staging.tokyo-odh-129.workers.dev VITE_SEISEKI_API_REQUIRED=false npm run build:staging
)
test -s local/dist/index.html
test -f local/dist/model/manifest.json
grep -lq 'seiseki-api-staging' local/dist/assets/*.js
grep -lq 'seiseki-local-v1' local/dist/assets/*.js
grep -q 'model-store.js' local/dist/index.html

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

(
  cd cloudflare
  npx wrangler deploy --env staging 2>&1 | tee /tmp/seiseki-staging-deploy.log
)

echo '--- DEPLOY RESULT ---'
grep -E 'Current Version ID|Uploaded|https://.*workers.dev' /tmp/seiseki-staging-deploy.log || true
