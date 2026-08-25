import fs from "node:fs";

const path = "cloudflare/tests/worker-sqlite.test.mjs";
let text = fs.readFileSync(path, "utf8");

function exact(oldText, newText, label) {
  if (text.includes(newText)) return;
  if (!text.includes(oldText)) throw new Error(`${label}: marker not found`);
  text = text.replace(oldText, newText);
}

exact(
`  const metadata = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}\`), env);`,
`  const metadata = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}\`, {
    headers: { "x-response-manage-token": created.manageToken }
  }), env);`,
"metadata manage token"
);

exact(
`  const remove = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}\`, {
    method: "DELETE"
  }), env);`,
`  const remove = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}\`, {
    method: "DELETE",
    headers: { "x-response-manage-token": created.manageToken }
  }), env);`,
"delete manage token"
);

// Preserve the anonymous one-time token in AI tests instead of discarding the create payload.
text = text.replaceAll(
`  const responseId = (await create.json()).id;
  await Promise.all(pending);`,
`  const createdPayload = await create.json();
  const responseId = createdPayload.id;
  const responseAuthHeaders = { "x-response-manage-token": createdPayload.manageToken };
  await Promise.all(pending);`
);

text = text.replaceAll(
`new Request(\`http://local/api/responses/\${responseId}/analysis\`), env)`,
`new Request(\`http://local/api/responses/\${responseId}/analysis\`, { headers: responseAuthHeaders }), env)`
);

exact(
`  assert.deepEqual(queued, [{ type: "analyze-response", responseId }]);`,
`  assert.deepEqual(queued, [{ type: "analyze-response", responseId, revision: 1 }]);`,
"queue revision expectation"
);

exact(
`  const message = () => ({
    id: crypto.randomUUID(), body: queued[0], attempts: 1,
    ack() {}, retry() { throw new Error("unexpected retry"); }
  });
  await Promise.all([
    worker.queue({ messages: [message()] }, env),
    worker.queue({ messages: [message()] }, env)
  ]);

  assert.equal(aiCalls, 1);`,
`  let retries = 0;
  const message = () => ({
    id: crypto.randomUUID(), body: queued[0], attempts: 1,
    ack() {}, retry() { retries += 1; }
  });
  await Promise.all([
    worker.queue({ messages: [message()] }, env),
    worker.queue({ messages: [message()] }, env)
  ]);

  assert.equal(aiCalls, 1);
  assert.equal(retries, 1);`,
"duplicate delivery retry expectation"
);

fs.writeFileSync(path, text);
console.log("Updated legacy response-auth regression expectations.");
