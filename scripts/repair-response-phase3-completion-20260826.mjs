import fs from "node:fs";

const path = "cloudflare/src/db.mjs";
let text = fs.readFileSync(path, "utf8");
const start = text.indexOf("export async function completeResponseAnalysis");
const end = text.indexOf("export async function failResponseAnalysis", start);
if (start < 0 || end < 0) throw new Error("completeResponseAnalysis boundary not found");

const replacement = `export async function completeResponseAnalysis(db, responseId, runId, expectedRevision, analysis, metadata) {
  const revision = Number(expectedRevision);
  const completedAt = Date.now();
  const preCompletionGuard = \`EXISTS (
    SELECT 1
    FROM responses r
    JOIN analysis_runs ar ON ar.id = ?
    WHERE r.id = ? AND r.revision = ? AND r.analysis_status = 'pending'
      AND ar.response_id = r.id AND ar.response_revision = ?
      AND ar.status = 'running' AND COALESCE(ar.lease_until, 0) >= ?
  )\`;

  // D1 batch statements execute in order inside one transaction. Keep every chunk mutation
  // before the response flips pending -> completed so the same pre-completion guard remains true.
  const statements = [
    db.prepare(\`
      DELETE FROM opinion_chunks
      WHERE response_id = ? AND \${preCompletionGuard}
    \`).bind(responseId, runId, responseId, revision, revision, completedAt)
  ];
  for (const chunk of analysis.chunks) {
    statements.push(db.prepare(\`
      INSERT INTO opinion_chunks (
        response_id, created_at, summary, category, topic,
        target_type, target_name, emotion, criticality, fact_status, provenance_json
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE \${preCompletionGuard}
    \`).bind(
      responseId, completedAt, chunk.s, chunk.cat, chunk.topic,
      chunk.tt, chunk.tn, chunk.emo, chunk.crit, chunk.fact,
      JSON.stringify({ ...metadata, responseRevision: revision, analysisRunId: runId }),
      runId, responseId, revision, revision, completedAt
    ));
  }

  const responseResultIndex = statements.length;
  statements.push(db.prepare(\`
    UPDATE responses
    SET analysis_status = 'completed', analysis_json = ?
    WHERE id = ? AND revision = ? AND analysis_status = 'pending'
      AND EXISTS (
        SELECT 1 FROM analysis_runs
        WHERE id = ? AND response_id = ? AND response_revision = ?
          AND status = 'running' AND COALESCE(lease_until, 0) >= ?
      )
  \`).bind(JSON.stringify(analysis), responseId, revision, runId, responseId, revision, completedAt));

  const runResultIndex = statements.length;
  statements.push(db.prepare(\`
    UPDATE analysis_runs
    SET status = 'completed', completed_at = ?, error_code = NULL, lease_until = NULL
    WHERE id = ? AND response_id = ? AND response_revision = ? AND status = 'running'
      AND COALESCE(lease_until, 0) >= ?
      AND EXISTS (
        SELECT 1 FROM responses
        WHERE id = ? AND revision = ? AND analysis_status = 'completed'
      )
  \`).bind(completedAt, runId, responseId, revision, completedAt, responseId, revision));

  const results = await db.batch(statements);
  const responseUpdated = Number(results?.[responseResultIndex]?.meta?.changes ?? 0) === 1;
  const runUpdated = Number(results?.[runResultIndex]?.meta?.changes ?? 0) === 1;
  if (responseUpdated && runUpdated) return true;

  const runState = await db.prepare(\`
    SELECT lease_until AS leaseUntil, status
    FROM analysis_runs WHERE id = ?
  \`).bind(runId).first();
  const code = Number(runState?.leaseUntil ?? 0) < completedAt ? "LEASE_EXPIRED" : "STALE_REVISION";
  await markRunStale(db, runId, code);
  return false;
}`;

text = text.slice(0, start) + replacement + "\n\n" + text.slice(end);
fs.writeFileSync(path, text);
console.log("Repaired Phase 3 completion ordering.");
