#!/usr/bin/env bash
set -euo pipefail

mapfile -t archives < <(find local-llm-import -maxdepth 1 -type f -name '*.zip' -print | sort)
test "${#archives[@]}" -eq 1
rm -rf /tmp/seiseki-local-llm
mkdir -p /tmp/seiseki-local-llm
unzip -q "${archives[0]}" -d /tmp/seiseki-local-llm
LLM_SRC=/tmp/seiseki-local-llm/localllm-files
test -d "$LLM_SRC"

(
  cd "$LLM_SRC"
  sha256sum -c "$GITHUB_WORKSPACE/.github/local-llm-sha256.txt"
)

cp -a "$LLM_SRC/.github/workflows/deploy-staging.yml" .github/workflows/deploy-staging.yml
cp -a "$LLM_SRC/core/logic.js" core/logic.js
cp -a "$LLM_SRC/core/ui.jsx" core/ui.jsx
cp -a "$LLM_SRC/core/seiseki-local-bridge.js" core/seiseki-local-bridge.js
cp -a "$LLM_SRC/scripts/build-app.mjs" scripts/build-app.mjs
cp -a "$LLM_SRC/tests/local-bridge.test.js" tests/local-bridge.test.js
cp -a "$LLM_SRC/local/index.html" local/index.html
cp -a "$LLM_SRC/local/.env.staging.example" local/.env.staging.example
rm -rf local/public/model
mkdir -p local/public/model
cp -a "$LLM_SRC/local/public/model/." local/public/model/
cat > local/public/model/LICENSE-modernbert-ja-30m.txt <<'EOF'
MIT License

Copyright (c) 2025 SB Intuitions

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF

grep -qxF '**/dist/' .gitignore || printf '\n**/dist/\n' >> .gitignore

grep -q '\["quantum", "量子観測"\]' core/ui.jsx
grep -q 'quantum: "/app/quantum"' core/ui.jsx
grep -q 'seiseki-opinion-network-preview.tokyo-odh-129.workers.dev' core/ui.jsx

node scripts/build-app.mjs
grep -q 'seiseki-local-v1' app/seiseki.jsx
grep -q 'quantum: "/app/quantum"' app/seiseki.jsx
cmp app/seiseki.jsx local/src/App.jsx

node tests/test.js
node tests/local-bridge.test.js
node tests/page-routing.test.mjs
node tests/balcheck.js app/seiseki.jsx
node tests/quantum-entanglement-engine.test.mjs

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
test -f local/dist/model/LICENSE-modernbert-ja-30m.txt
grep -lq 'seiseki-api-staging' local/dist/assets/*.js
grep -lq 'seiseki-local-v1' local/dist/assets/*.js
grep -q 'model-store.js' local/dist/index.html

rm -rf local/dist local/node_modules cloudflare/node_modules local-llm-import
cat > IMPORT_RESULT.md <<'EOF'
# Local LLM import result

- result: success
- source: seisekiローカルLLM実ファイル20260822.zip
- quantum integration preserved: yes
- local LLM fingerprints: verified
- application tests: passed
- Cloudflare worker tests: passed
- staging build: passed
- Cloudflare deploy: not run
- D1 migrations: not run
- production: untouched
EOF

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- .gitignore .github core scripts tests local app IMPORT_RESULT.md local-llm-import
git commit -m "Integrate verified local LLM into SEISEKI quantum branch"
git push origin HEAD:feat/local-llm-stage0-1
