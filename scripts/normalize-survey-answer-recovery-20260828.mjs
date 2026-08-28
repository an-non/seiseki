import { readFileSync, writeFileSync } from "node:fs";

function normalize(path, pairs) {
  let source = readFileSync(path, "utf8");
  for (const [from, to] of pairs) {
    if (!source.includes(from)) continue;
    source = source.replace(from, to);
  }
  writeFileSync(path, source, "utf8");
}

normalize("core/ui.jsx", [
  ['{chunkTotal > 0 ? (      {chunkTotal > 0 ? (', '{chunkTotal > 0 ? ('],
  ['if (phase === "consent") {  if (phase === "consent") {', 'if (phase === "consent") {']
]);

normalize("cloudflare/src/db.mjs", [
  ['export async function deleteResponse(db, id) {export async function deleteResponse(db, id) {', 'export async function deleteResponse(db, id) {']
]);

normalize("cloudflare/src/index.mjs", [
  ['const requeueId = routeRequeueId(url.pathname);  const requeueId = routeRequeueId(url.pathname);', 'const requeueId = routeRequeueId(url.pathname);']
]);

normalize("cloudflare/tests/response-phase4-backend.test.mjs", [
  ['test("healthy pending current revision is not manually requeued", async () => {test("healthy pending current revision is not manually requeued", async () => {', 'test("healthy pending current revision is not manually requeued", async () => {']
]);

console.log("survey recovery patch boundaries normalized");
