import { readFileSync, writeFileSync } from "node:fs";

const path = "cloudflare/tests/response-phase4-backend.test.mjs";
let source = readFileSync(path, "utf8");
const from = `  const staleAnswers = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/answers\`, {\n    method: "PATCH",\n    headers: { "content-type": "application/json", authorization: \`Bearer \${owner.token}\` },\n    body: JSON.stringify({ expectedRevision: 1, answers })\n  }), env);\n  assert.equal(staleAnswers.status, 409);`;
const to = `  const staleInitial = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/initial\`, {\n    method: "PATCH",\n    headers: { "content-type": "application/json", authorization: \`Bearer \${owner.token}\` },\n    body: JSON.stringify({ expectedRevision: 1, answers, freeText: "stale combined update" })\n  }), env);\n  assert.equal(staleInitial.status, 409);`;
const count = source.split(from).length - 1;
if (count !== 1) throw new Error("expected one stale answers block, found " + count);
source = source.replace(from, to);
writeFileSync(path, source, "utf8");
console.log("stale snapshot contract now exercises /initial");
