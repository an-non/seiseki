import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const EXPECTED_HEAD = "7d761f6a7ecbc130f8cb66fef5004fdaf3b66c51";
const rootArg = process.argv.find(arg => arg.startsWith("--repo="));
const root = path.resolve(rootArg ? rootArg.slice("--repo=".length) : process.cwd());
const dryRun = process.argv.includes("--check");
const runTests = !process.argv.includes("--no-tests");

function rel(name) { return path.join(root, name); }
const buffers = new Map();
function read(name) {
  if (buffers.has(name)) return buffers.get(name);
  return fs.readFileSync(rel(name), "utf8");
}
function write(name, value) { buffers.set(name, value); }
function replaceExactCount(name, before, after, expectedCount) {
  const source = read(name);
  const count = source.split(before).length - 1;
  if (count !== expectedCount) throw new Error("anchor count mismatch in " + name + ": expected " + expectedCount + " but found " + count);
  write(name, source.split(before).join(after));
}
function assertFile(name) {
  if (!fs.existsSync(rel(name))) throw new Error("missing required file: " + name);
}
function replaceOnce(name, before, after) {
  const source = read(name);
  const first = source.indexOf(before);
  if (first < 0) throw new Error("anchor not found in " + name + ": " + before.slice(0, 100));
  if (source.indexOf(before, first + before.length) >= 0) throw new Error("anchor is not unique in " + name);
  write(name, source.slice(0, first) + after + source.slice(first + before.length));
}
function ensure(name, needle) {
  if (!read(name).includes(needle)) throw new Error("postcondition missing in " + name + ": " + needle.slice(0, 120));
}
function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function run(command, args, cwd = root) {
  console.log("+", command, args.join(" "));
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

for (const name of [
  "core/ui.jsx",
  "cloudflare/src/db.mjs",
  "cloudflare/src/index.mjs",
  "cloudflare/src/auth.mjs",
  "cloudflare/tests/response-phase4-backend.test.mjs",
  "tests/page-routing.test.mjs",
  "scripts/apply-mobile-ui-fix.mjs",
  ".github/workflows/mobile-ui-staging.yml"
]) assertFile(name);

const head = git("rev-parse", "HEAD");
if (head !== EXPECTED_HEAD) throw new Error("refusing to patch unexpected HEAD: " + head + " (expected " + EXPECTED_HEAD + ")");
if (git("status", "--porcelain")) throw new Error("working tree must be clean before Phase 5 patch");
console.log("SEISEKI Phase 5 baseline OK:", head);

replaceOnce("core/ui.jsx",
`const VIEW_PATHS = {
  entry: "/",
  home: "/app",
  survey: "/survey",
  complete: "/survey/complete",
  dash: "/app/dashboard",
  tree: "/app/network",
  quantum: "/app/quantum",
  opinions: "/app/opinions",
  mine: "/account/response",
  admin: "/admin"
};

function viewFromPath(pathname) {
  const path = String(pathname || "/").replace(/\\/+$/, "") || "/";
  for (const key of Object.keys(VIEW_PATHS)) {
    if (VIEW_PATHS[key] === path) return key;
  }
  return "entry";
}`,
`const VIEW_PATHS = {
  entry: "/",
  home: "/app",
  survey: "/survey",
  complete: "/survey/complete",
  dash: "/app/dashboard",
  tree: "/app/tree",
  quantum: "/app/quantum",
  opinions: "/app/opinions",
  mine: "/account/response",
  admin: "/admin"
};
const VIEW_PATH_ALIASES = { "/app/network": "tree" };

function viewFromPath(pathname) {
  const path = String(pathname || "/").replace(/\\/+$/, "") || "/";
  for (const key of Object.keys(VIEW_PATHS)) {
    if (VIEW_PATHS[key] === path) return key;
  }
  return VIEW_PATH_ALIASES[path] || "entry";
}`);

replaceOnce("core/ui.jsx",
`async function acctGet(name, strictRemote) {
  const nm = normAcctName(name);
  if (!nm) return null;
  if (cloudApiEnabled()) {
    const session = await pGet("session:current");
    if (!session || !session.token) return null;
    try {
      const result = await cloudAccountCall("/api/accounts/me", "GET", undefined, session.token);
      return cloudAccountRecord(result, session.token);
    } catch (e) {
      if (strictRemote) throw e;
      return null;
    }
  }
  return await sGet(await acctStorageKey(nm));
}`,
`async function acctGet(name, strictRemote) {
  const nm = normAcctName(name);
  if (!nm) return null;
  if (cloudApiEnabled()) {
    const session = await pGet("session:current");
    if (!session || !session.token) {
      if (strictRemote) {
        const error = new Error("remote account session is missing");
        error.status = 401;
        error.code = "AUTH_SESSION_MISSING";
        throw error;
      }
      return null;
    }
    try {
      const result = await cloudAccountCall("/api/accounts/me", "GET", undefined, session.token);
      const record = cloudAccountRecord(result, session.token);
      if (!record && strictRemote) {
        const error = new Error("remote account payload is invalid");
        error.code = "ACCOUNT_PAYLOAD_INVALID";
        throw error;
      }
      return record;
    } catch (e) {
      if (strictRemote) throw e;
      return null;
    }
  }
  return await sGet(await acctStorageKey(nm));
}`);

replaceOnce("core/ui.jsx",
`    if (cloudApiEnabled() && ["home", "dash", "tree", "opinions"].includes(v)) {
      refreshAgg().catch(error => console.warn("aggregate navigation refresh failed", error));
    }
    if (cloudApiEnabled() && ["home", "dash", "tree", "opinions"].includes(v)) {
      refreshAgg().catch(error => console.warn("aggregate navigation refresh failed", error));
    }`,
`    if (cloudApiEnabled() && ["home", "dash", "tree", "opinions"].includes(v)) {
      refreshAgg().catch(error => console.warn("aggregate navigation refresh failed", error));
    }`);

replaceOnce("core/ui.jsx",
`            onDraftChange={d => { setHasDraft(d); if (!d && session) acctGet(session.name).then(r => setMyId((r && r.respId) || "")); }} />`,
`            onDraftChange={d => {
              setHasDraft(d);
              if (!d && session) {
                acctGet(session.name, cloudApiEnabled())
                  .then(r => { if (r && r.respId) setMyId(r.respId); })
                  .catch(error => console.warn("account response refresh failed", error));
              }
            }} />`);

replaceOnce("core/ui.jsx",
`  const [noSelf, setNoSelf] = useState(false); // ログイン済みだが未回答

  /* ログイン中はアカウントに紐付いた回答を自動表示する(IDの入力は不要)。
     未ログインでも、回答IDによる照会(合鍵)は引き続き使える。 */
  useEffect(() => {
    let alive = true;
    setNoSelf(false);
    (async () => {
      if (session) {
        const rec = await acctGet(session.name);
        if (!alive) return;
        if (rec && rec.respId) { setIdv(rec.respId); lookup(rec.respId); }
        else setNoSelf(true);
        return;
      }
      const last = await pGet("last:id");
      if (alive && last && last.id) setIdv(last.id);
    })();
    return () => { alive = false; };
  }, [session]);`,
`  const [noSelf, setNoSelf] = useState(false); // ログイン済みだが未回答
  const [selfLookupError, setSelfLookupError] = useState("");
  const [selfLookupNonce, setSelfLookupNonce] = useState(0);

  /* ログイン中はアカウントに紐付いた回答を自動表示する(IDの入力は不要)。
     通信失敗と「回答なし」は分離し、失敗時に未回答扱いへ落とさない。 */
  useEffect(() => {
    let alive = true;
    setNoSelf(false);
    setSelfLookupError("");
    (async () => {
      if (session) {
        try {
          const rec = await acctGet(session.name, cloudApiEnabled());
          if (!alive) return;
          if (rec && rec.respId) { setIdv(rec.respId); lookup(rec.respId); }
          else setNoSelf(true);
        } catch (error) {
          if (!alive) return;
          console.warn("account response lookup failed", error);
          setSelfLookupError("本人回答を確認できませんでした。通信状態を確認して、もう一度試してください。");
        }
        return;
      }
      const last = await pGet("last:id");
      if (alive && last && last.id) setIdv(last.id);
    })();
    return () => { alive = false; };
  }, [session, selfLookupNonce]);`);

replaceOnce("core/ui.jsx",
`      {session && noSelf ? (
        <Card pad={13} style={{ marginBottom: 12, borderColor: C.green }}>`,
`      {session && selfLookupError ? (
        <Card pad={13} style={{ marginBottom: 12, borderColor: C.bengara }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, flex: 1, minWidth: 200 }}>{selfLookupError}</div>
            <Btn small kind="ghost" onClick={() => setSelfLookupNonce(selfLookupNonce + 1)}>もう一度確認する</Btn>
          </div>
        </Card>
      ) : null}
      {session && noSelf && !selfLookupError ? (
        <Card pad={13} style={{ marginBottom: 12, borderColor: C.green }}>`);

replaceOnce("core/ui.jsx",
`const FONT_BODY = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Noto Sans JP",-apple-system,BlinkMacSystemFont,sans-serif';
const FONT_DISP = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Noto Sans JP",-apple-system,BlinkMacSystemFont,sans-serif';
const FONT_MONO = 'ui-monospace,"SFMono-Regular","SF Mono",Menlo,Consolas,monospace';`,
`const FONT_BODY = '"Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif';
const FONT_DISP = '"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif';
const FONT_MONO = '"IBM Plex Mono","SF Mono","Consolas",monospace';`);

replaceOnce("scripts/apply-mobile-ui-fix.mjs",
`const stableJapaneseSans = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Noto Sans JP",-apple-system,BlinkMacSystemFont,sans-serif';`,
`const stableJapaneseBody = '"Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif';
const stableJapaneseDisplay = '"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif';
const stableMono = '"IBM Plex Mono","SF Mono","Consolas",monospace';`);
replaceOnce("scripts/apply-mobile-ui-fix.mjs",
`  /const FONT_BODY = '[^']+';/u,
  \`const FONT_BODY = '\${stableJapaneseSans}';\``,
`  /const FONT_BODY = '[^']+';/u,
  \`const FONT_BODY = '\${stableJapaneseBody}';\``);
replaceOnce("scripts/apply-mobile-ui-fix.mjs",
`  /const FONT_DISP = '[^']+';/u,
  \`const FONT_DISP = '\${stableJapaneseSans}';\``,
`  /const FONT_DISP = '[^']+';/u,
  \`const FONT_DISP = '\${stableJapaneseDisplay}';\``);
replaceOnce("scripts/apply-mobile-ui-fix.mjs",
`  /const FONT_MONO = '[^']+';/u,
  'const FONT_MONO = \'ui-monospace,"SFMono-Regular","SF Mono",Menlo,Consolas,monospace\';'`,
`  /const FONT_MONO = '[^']+';/u,
  \`const FONT_MONO = '\${stableMono}';\``);
replaceOnce("scripts/apply-mobile-ui-fix.mjs",
`if (!src.includes('const FONT_BODY = \'"Hiragino Sans"')) throw new Error("Hiragino-first body font missing");
if (!src.includes('const FONT_DISP = \'"Hiragino Sans"')) throw new Error("Hiragino-first display font missing");`,
`if (!src.includes('const FONT_BODY = \'"Zen Kaku Gothic New"')) throw new Error("historical body font role missing");
if (!src.includes('const FONT_DISP = \'"Shippori Mincho"')) throw new Error("historical display font role missing");
if (!src.includes('const FONT_MONO = \'"IBM Plex Mono"')) throw new Error("historical mono font role missing");`);
replaceOnce(".github/workflows/mobile-ui-staging.yml",
`          grep -q 'const FONT_BODY = '\''"Hiragino Sans"' core/ui.jsx
          grep -q 'const FONT_DISP = '\''"Hiragino Sans"' core/ui.jsx
          grep -q 'SFMono-Regular' core/ui.jsx`,
`          grep -q 'const FONT_BODY = '\''"Zen Kaku Gothic New"' core/ui.jsx
          grep -q 'const FONT_DISP = '\''"Shippori Mincho"' core/ui.jsx
          grep -q 'const FONT_MONO = '\''"IBM Plex Mono"' core/ui.jsx`);

const migration = `ALTER TABLE responses ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;\nUPDATE responses SET updated_at = created_at WHERE updated_at = 0;\n`;
const migrationName = "cloudflare/migrations/0007_response_updated_at.sql";
const migrationPath = rel(migrationName);
if (fs.existsSync(migrationPath)) {
  if (fs.readFileSync(migrationPath, "utf8") !== migration) throw new Error("0007_response_updated_at.sql already exists with unexpected content");
} else write(migrationName, migration);

replaceOnce("cloudflare/src/db.mjs",
`        id, created_at, app_version, consent_version, consent_at,
        age, gender, region, occupation, party, free_text,
        analysis_status, analysis_json, demo_flag, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, 1)`,
`        id, created_at, updated_at, app_version, consent_version, consent_at,
        age, gender, region, occupation, party, free_text,
        analysis_status, analysis_json, demo_flag, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, 1)`);
replaceOnce("cloudflare/src/db.mjs",
`      response.id,
      response.createdAt,
      response.appVersion,`,
`      response.id,
      response.createdAt,
      response.createdAt,
      response.appVersion,`);
replaceOnce("cloudflare/src/db.mjs",
`    SELECT id, created_at AS createdAt, app_version AS appVersion,
           consent_version AS consentVersion, analysis_status AS analysisStatus,
           demo_flag AS demoFlag, revision`,
`    SELECT id, created_at AS createdAt, updated_at AS updatedAt, app_version AS appVersion,
           consent_version AS consentVersion, analysis_status AS analysisStatus,
           demo_flag AS demoFlag, revision`);
replaceOnce("cloudflare/src/db.mjs",
`      SET free_text = ?, revision = revision + 1, analysis_status = 'pending', analysis_json = NULL
      WHERE id = ? AND revision = ?
    \`).bind(freeText, id, expectedRevision)`,
`      SET free_text = ?, updated_at = ?, revision = revision + 1, analysis_status = 'pending', analysis_json = NULL
      WHERE id = ? AND revision = ?
    \`).bind(freeText, now, id, expectedRevision)`);
replaceOnce("cloudflare/src/db.mjs",
`      SET revision = revision + 1, analysis_status = 'pending', analysis_json = NULL
      WHERE id = ? AND revision = ?
    \`).bind(id, expectedRevision)`,
`      SET updated_at = ?, revision = revision + 1, analysis_status = 'pending', analysis_json = NULL
      WHERE id = ? AND revision = ?
    \`).bind(now, id, expectedRevision)`);

replaceOnce("cloudflare/src/db.mjs",
`export async function getResponseAnalysis(db, id) {
  const row = await db.prepare(\`
    SELECT analysis_status AS analysisStatus, analysis_json AS analysisJson, revision
    FROM responses
    WHERE id = ?
  \`).bind(id).first();
  if (!row) return null;
  const revision = Number(row.revision ?? 1);
  const run = await db.prepare(\`
    SELECT status, error_code AS errorCode, response_revision AS responseRevision
    FROM analysis_runs
    WHERE response_id = ? AND response_revision = ?
    ORDER BY id DESC LIMIT 1
  \`).bind(id, revision).first();
  let analysis = null;
  if (row.analysisJson) {
    try { analysis = JSON.parse(row.analysisJson); } catch { analysis = null; }
  }
  return {
    analysisStatus: row.analysisStatus === "pending" && run?.status === "running" ? "running" : row.analysisStatus,
    revision,
    analysis,
    ...(run?.errorCode ? { errorCode: run.errorCode } : {})
  };
}`,
`export const ANALYSIS_STALL_AFTER_MS = 60000;

export function analysisRetryState(row, run, now = Date.now()) {
  const responseStatus = String(row?.analysisStatus || "");
  const runStatus = String(run?.status || "");
  const updatedAt = Number(row?.updatedAt || 0);
  const startedAt = Number(run?.startedAt || 0);
  const completedAt = Number(run?.completedAt || 0);
  const leaseUntil = Number(run?.leaseUntil || 0);
  const lastActivityAt = Math.max(updatedAt, startedAt, completedAt);
  const expiredRunning = responseStatus === "pending" && runStatus === "running" && ((leaseUntil > 0 && leaseUntil <= now) || (leaseUntil <= 0 && startedAt > 0 && now - startedAt >= ANALYSIS_STALL_AFTER_MS));
  const waitingTooLong = responseStatus === "pending" && runStatus !== "running" && lastActivityAt > 0 && now - lastActivityAt >= ANALYSIS_STALL_AFTER_MS;
  const stalled = expiredRunning || waitingTooLong;
  return { stalled, retryable: responseStatus === "failed" || stalled, lastActivityAt, leaseUntil };
}

async function currentAnalysisRow(db, id) {
  const row = await db.prepare(\`
    SELECT analysis_status AS analysisStatus, analysis_json AS analysisJson, revision, updated_at AS updatedAt
    FROM responses WHERE id = ?
  \`).bind(id).first();
  if (!row) return { row: null, run: null };
  const revision = Number(row.revision ?? 1);
  const run = await db.prepare(\`
    SELECT id, status, error_code AS errorCode, response_revision AS responseRevision,
           started_at AS startedAt, completed_at AS completedAt, lease_until AS leaseUntil
    FROM analysis_runs WHERE response_id = ? AND response_revision = ? ORDER BY id DESC LIMIT 1
  \`).bind(id, revision).first();
  return { row, run };
}

export async function getResponseAnalysis(db, id) {
  const { row, run } = await currentAnalysisRow(db, id);
  if (!row) return null;
  const revision = Number(row.revision ?? 1);
  let analysis = null;
  if (row.analysisJson) { try { analysis = JSON.parse(row.analysisJson); } catch { analysis = null; } }
  const retry = analysisRetryState(row, run);
  return {
    analysisStatus: row.analysisStatus === "pending" && run?.status === "running" ? "running" : row.analysisStatus,
    revision,
    analysis,
    updatedAt: Number(row.updatedAt || 0),
    lastActivityAt: retry.lastActivityAt,
    stalled: retry.stalled,
    retryable: retry.retryable,
    ...(run?.startedAt ? { startedAt: Number(run.startedAt) } : {}),
    ...(run?.completedAt ? { completedAt: Number(run.completedAt) } : {}),
    ...(run?.leaseUntil ? { leaseUntil: Number(run.leaseUntil) } : {}),
    ...(run?.errorCode ? { errorCode: run.errorCode } : {})
  };
}

export async function prepareResponseAnalysisRetry(db, id, expectedRevision) {
  const revision = Number(expectedRevision);
  const now = Date.now();
  const { row, run } = await currentAnalysisRow(db, id);
  if (!row) return { status: "not_found" };
  if (Number(row.revision ?? 1) !== revision) return { status: "stale" };
  const retry = analysisRetryState(row, run, now);
  if (!retry.retryable) return { status: "not_retryable", stalled: retry.stalled };
  if (run?.status === "running" && retry.stalled) {
    await db.prepare(\`
      UPDATE analysis_runs SET status = 'failed', completed_at = ?, error_code = 'LEASE_EXPIRED', lease_until = NULL
      WHERE id = ? AND response_id = ? AND response_revision = ? AND status = 'running'
        AND ((COALESCE(lease_until, 0) > 0 AND lease_until <= ?) OR (COALESCE(lease_until, 0) <= 0 AND started_at <= ?))
    \`).bind(now, run.id, id, revision, now, now - ANALYSIS_STALL_AFTER_MS).run();
  }
  let resetFromFailed = false;
  if (row.analysisStatus === "failed") {
    const result = await db.prepare(\`
      UPDATE responses SET analysis_status = 'pending', analysis_json = NULL
      WHERE id = ? AND revision = ? AND analysis_status = 'failed'
        AND NOT EXISTS (SELECT 1 FROM analysis_runs WHERE response_id = ? AND response_revision = ? AND status = 'running' AND COALESCE(lease_until, 0) > ?)
    \`).bind(id, revision, id, revision, now).run();
    if (Number(result.meta?.changes ?? 0) !== 1) return { status: "not_retryable" };
    resetFromFailed = true;
  }
  return { status: "ready", revision, resetFromFailed };
}

export async function restoreResponseAnalysisFailure(db, id, expectedRevision) {
  const revision = Number(expectedRevision);
  const now = Date.now();
  const result = await db.prepare(\`
    UPDATE responses SET analysis_status = 'failed', analysis_json = NULL
    WHERE id = ? AND revision = ? AND analysis_status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM analysis_runs WHERE response_id = ? AND response_revision = ? AND status = 'running' AND COALESCE(lease_until, 0) > ?)
  \`).bind(id, revision, id, revision, now).run();
  return Number(result.meta?.changes ?? 0) === 1;
}`);

replaceOnce("cloudflare/src/index.mjs", `import { getResponseAnalysis } from "./db.mjs";`, `import { getResponseAnalysis, prepareResponseAnalysisRetry, restoreResponseAnalysisFailure } from "./db.mjs";`);
replaceOnce("cloudflare/src/index.mjs",
`    dispatchUpdatedAnalysis(env, ctx, freeTextId, nextRevision);
    return json({ id: freeTextId, revision: nextRevision, analysisStatus: "pending" });`,
`    dispatchUpdatedAnalysis(env, ctx, freeTextId, nextRevision);
    const current = await getResponseMetadata(env.DB, freeTextId);
    return json({ id: freeTextId, revision: nextRevision, analysisStatus: "pending", updatedAt: Number(current?.updatedAt || Date.now()) });`);
replaceOnce("cloudflare/src/index.mjs",
`    dispatchUpdatedAnalysis(env, ctx, answersId, nextRevision);
    return json({ id: answersId, revision: nextRevision, analysisStatus: "pending" });`,
`    dispatchUpdatedAnalysis(env, ctx, answersId, nextRevision);
    const current = await getResponseMetadata(env.DB, answersId);
    return json({ id: answersId, revision: nextRevision, analysisStatus: "pending", updatedAt: Number(current?.updatedAt || Date.now()) });`);
replaceOnce("cloudflare/src/index.mjs",
`    const current = await getResponseMetadata(env.DB, requeueId);
    if (!current) throw new RequestError(404, "NOT_FOUND", "response was not found");
    if (Number(current.revision ?? 1) !== expectedRevision) {
      throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before retrying");
    }
    if (current.analysisStatus !== "pending") {
      throw new RequestError(409, "ANALYSIS_NOT_PENDING", "only a pending analysis can be requeued");
    }
    await enqueueAnalysisRevision(env, requeueId, expectedRevision);
    return json({ id: requeueId, revision: expectedRevision, analysisStatus: "pending", queued: true }, 202);`,
`    const current = await getResponseAnalysis(env.DB, requeueId);
    if (!current) throw new RequestError(404, "NOT_FOUND", "response was not found");
    if (Number(current.revision ?? 1) !== expectedRevision) throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before retrying");
    if (!current.retryable) throw new RequestError(409, "ANALYSIS_NOT_RETRYABLE", "analysis can be retried only after failure or a detected stall");
    const prepared = await prepareResponseAnalysisRetry(env.DB, requeueId, expectedRevision);
    if (prepared.status === "stale") throw new RequestError(409, "REVISION_CONFLICT", "response revision changed; reload before retrying");
    if (prepared.status !== "ready") throw new RequestError(409, "ANALYSIS_NOT_RETRYABLE", "analysis is no longer retryable");
    try { await enqueueAnalysisRevision(env, requeueId, expectedRevision); }
    catch (error) { if (prepared.resetFromFailed) await restoreResponseAnalysisFailure(env.DB, requeueId, expectedRevision); throw error; }
    return json({ id: requeueId, revision: expectedRevision, analysisStatus: "pending", stalled: false, retryable: false, queued: true }, 202);`);

replaceOnce("cloudflare/src/auth.mjs", `    SELECT r.id, r.created_at AS createdAt, r.app_version AS appVersion,`, `    SELECT r.id, r.created_at AS createdAt, r.updated_at AS updatedAt, r.app_version AS appVersion,`);
replaceOnce("cloudflare/src/auth.mjs", `      ts: Number(row.createdAt),
      ver: String(row.appVersion ?? ""),`, `      ts: Number(row.createdAt),
      updatedAt: Number(row.updatedAt || row.createdAt || 0),
      ver: String(row.appVersion ?? ""),`);

replaceOnce("core/ui.jsx",
`  return {
    status: knownStatuses.has(rawStatus) ? rawStatus : "pending",
    analysis: analysis,
    errorCode: String(payload && payload.errorCode || ""),
    revision: Number(payload && payload.revision || 0),
    mode: analysis && analysis.engine === "rules-fallback-v1" ? "fallback" : "ai"
  };`,
`  return {
    status: knownStatuses.has(rawStatus) ? rawStatus : "pending",
    analysis: analysis,
    errorCode: String(payload && payload.errorCode || ""),
    revision: Number(payload && payload.revision || 0),
    updatedAt: Number(payload && payload.updatedAt || 0),
    lastActivityAt: Number(payload && payload.lastActivityAt || 0),
    startedAt: Number(payload && payload.startedAt || 0),
    completedAt: Number(payload && payload.completedAt || 0),
    leaseUntil: Number(payload && payload.leaseUntil || 0),
    stalled: payload && payload.stalled === true,
    retryable: payload && payload.retryable === true,
    mode: analysis && analysis.engine === "rules-fallback-v1" ? "fallback" : "ai"
  };`);
replaceOnce("core/ui.jsx",
`  if (response.analysis && response.analysis.engine === "rules-fallback-v1") {
    return { tone: "warning", title: "規則による代替解析", detail: "AI解析が完了しなかったため、保存済み回答を規則解析で処理しました。" };
  }
  if (response.cloudAnalysisStatus === "running") {`,
`  if (response.analysis && response.analysis.engine === "rules-fallback-v1") {
    return { tone: "warning", title: "規則による代替解析", detail: "AI解析が完了しなかったため、保存済み回答を規則解析で処理しました。" };
  }
  if (response.cloudAnalysisStalled === true) {
    return { tone: "warning", title: "AI解析が停止している可能性", detail: "回答本文は保存済みです。現在revisionだけを再試行できます。" };
  }
  if (response.cloudAnalysisStatus === "running") {`);
replaceOnce("core/ui.jsx",
`  if (response) {
    const state = normalizeCloudAnalysisResult(raw);
    response.remoteId = id;
    response.remoteRevision = Number(raw && raw.revision || response.revision || response.seq || 1);
    response.revision = response.remoteRevision;
    response.analysis = state.analysis;
    response.analysisSource = "cloudflare";
    response.cloudAnalysisStatus = state.status;
    response.cloudAnalysisMode = state.mode;
  }
  return response;`,
`  if (response) {
    const rawRevision = Number(raw && raw.revision || response.revision || response.seq || 1);
    let state = normalizeCloudAnalysisResult(raw);
    try {
      const currentState = await cloudLoadResponseAnalysis(id);
      if (currentState && Number(currentState.revision || 0) === rawRevision) state = currentState;
    } catch (error) { console.warn("current analysis metadata load failed", error); }
    response.remoteId = id;
    response.remoteRevision = rawRevision;
    response.revision = response.remoteRevision;
    response.updatedAt = Number(raw && raw.updatedAt || response.updatedAt || response.ts || 0);
    response.analysis = state.analysis;
    response.analysisSource = "cloudflare";
    response.cloudAnalysisStatus = state.status;
    response.cloudAnalysisMode = state.mode;
    response.cloudAnalysisErrorCode = state.errorCode;
    response.cloudAnalysisUpdatedAt = state.updatedAt || response.updatedAt;
    response.cloudAnalysisLastActivityAt = state.lastActivityAt;
    response.cloudAnalysisStartedAt = state.startedAt;
    response.cloudAnalysisCompletedAt = state.completedAt;
    response.cloudAnalysisLeaseUntil = state.leaseUntil;
    response.cloudAnalysisStalled = state.stalled;
    response.cloudAnalysisRetryable = state.retryable;
  }
  return response;`);
replaceExactCount("core/ui.jsx",
`        analysis: null, analysisSource: "cloudflare", cloudAnalysisStatus: "pending"
      };`,
`        analysis: null, analysisSource: "cloudflare", cloudAnalysisStatus: "pending",
        updatedAt: Number(updated.updatedAt || Date.now()),
        cloudAnalysisUpdatedAt: Number(updated.updatedAt || Date.now()),
        cloudAnalysisStalled: false, cloudAnalysisRetryable: false, cloudAnalysisErrorCode: ""
      };`, 2);
replaceOnce("core/ui.jsx", `      setCurrentResponse({ ...currentResponse, cloudAnalysisStatus: "pending" });`, `      setCurrentResponse({ ...currentResponse, cloudAnalysisStatus: "pending", cloudAnalysisStalled: false, cloudAnalysisRetryable: false, cloudAnalysisErrorCode: "" });`);
replaceOnce("core/ui.jsx",
`          <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>
            {append ? "追記後の全文" : "編集後全文"}が1500字以内で保存され、全文を再解析します。
          </div>`,
`          <div style={{ fontSize: 11, color: C.sub, marginTop: 4, lineHeight: 1.8 }}>
            {append ? "現在の全文は残したまま、この入力を新しい段落として末尾へ追加します。結合後の全文が1500字以内で保存され、その全文を再解析します。" : "現在の自由記述全文を、この入力内容で置き換えます。保存後は置き換え後の全文を再解析します。"}
          </div>`);
replaceOnce("core/ui.jsx",
`    return (
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <H2 eyebrow="CURRENT RESPONSE" sub={"回答ID " + id + " / revision " + revision}>現在の回答</H2>
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.8 }}>
            このアカウントには回答が1件あります。新しい回答を作らず、この回答を更新します。
          </div>
          <div style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 13 }}>
            {currentResponse.free || "（自由記述なし）"}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: C.sub }}>
            解析状態: {currentResponse.cloudAnalysisStatus || currentResponse.analysisStatus || "pending"}
          </div>
        </Card>
        {err ? <div style={{ color: C.bengara, fontSize: 12, marginBottom: 10 }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => { setEditText(""); setEditMode("append"); setErr(""); }}>自由記述を追記</Btn>
          <Btn kind="ghost" onClick={() => { setEditText(String(currentResponse.free || "")); setEditMode("free"); setErr(""); }}>自由記述を修正</Btn>
          <Btn kind="ghost" onClick={() => { setAnswers({ ...(currentResponse.answers || {}) }); setEditMode("answers"); setErr(""); }}>アンケート回答を修正</Btn>
          {(currentResponse.cloudAnalysisStatus === "pending") ? <Btn kind="ghost" onClick={retryCurrentAnalysis}>解析を再試行</Btn> : null}
          <Btn kind="ghost" onClick={() => goto("mine")}>自分の回答を確認</Btn>
        </div>
      </div>
    );`,
`    const currentAnalysisState = analysisStateLabel(currentResponse);
    const analysisUpdatedAt = Number(currentResponse.cloudAnalysisLastActivityAt || currentResponse.cloudAnalysisUpdatedAt || currentResponse.updatedAt || currentResponse.ts || 0);
    const canRetryAnalysis = currentResponse.cloudAnalysisRetryable === true;
    return (
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <H2 eyebrow="CURRENT RESPONSE" sub={"回答ID " + id + " / revision " + revision}>現在の回答</H2>
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.8 }}>このアカウントには回答が1件あります。新しい回答を作らず、この回答を更新します。</div>
          <div style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 13 }}>{currentResponse.free || "（自由記述なし）"}</div>
        </Card>
        <Card pad={13} style={{ marginBottom: 14, borderColor: currentAnalysisState && currentAnalysisState.tone === "error" ? C.bengara : C.rule }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>解析状態</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, fontSize: 11, color: C.sub }}>
            <div>revision <span style={{ fontFamily: FONT_MONO, color: C.ink }}>{revision}</span></div>
            <div>状態 <span style={{ color: C.ink }}>{currentAnalysisState ? currentAnalysisState.title : (currentResponse.cloudAnalysisStatus || "pending")}</span></div>
            <div>更新 <span style={{ color: C.ink }}>{analysisUpdatedAt ? fmtDT(analysisUpdatedAt) : "確認中"}</span></div>
          </div>
          {currentAnalysisState ? <div style={{ fontSize: 11, color: C.sub, marginTop: 7 }}>{currentAnalysisState.detail}</div> : null}
          {currentResponse.cloudAnalysisErrorCode ? <div style={{ fontSize: 11, color: C.bengara, marginTop: 5 }}>error: {currentResponse.cloudAnalysisErrorCode}</div> : null}
          {canRetryAnalysis ? <div style={{ marginTop: 10 }}><Btn small kind="ghost" onClick={retryCurrentAnalysis}>現在revisionの解析を再試行</Btn></div> : null}
        </Card>
        {err ? <div style={{ color: C.bengara, fontSize: 12, marginBottom: 10 }}>{err}</div> : null}
        <H2 eyebrow="UPDATE RESPONSE" sub="変更内容ごとに操作を分けています。どの更新でも保存後に現在revisionを再解析します。">回答を更新する</H2>
        <div style={{ display: "grid", gap: 10 }}>
          <Card pad={13}><div style={{ fontSize: 13, fontWeight: 700 }}>自由記述を追記</div><div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>現在の全文を残し、新しい段落を末尾へ追加してから全文を再解析します。</div><Btn small onClick={() => { setEditText(""); setEditMode("append"); setErr(""); }}>追記する</Btn></Card>
          <Card pad={13}><div style={{ fontSize: 13, fontWeight: 700 }}>自由記述を全文修正</div><div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>現在の自由記述全文を置き換え、置き換え後の全文を再解析します。</div><Btn small kind="ghost" onClick={() => { setEditText(String(currentResponse.free || "")); setEditMode("free"); setErr(""); }}>全文を修正する</Btn></Card>
          <Card pad={13}><div style={{ fontSize: 13, fontWeight: 700 }}>アンケート回答を修正</div><div style={{ fontSize: 11, color: C.sub, margin: "3px 0 9px" }}>初回回答時に保存された設問スナップショットだけを修正します。自由記述は変えず、現在の全文を再解析します。</div><Btn small kind="ghost" onClick={() => { setAnswers({ ...(currentResponse.answers || {}) }); setEditMode("answers"); setErr(""); }}>アンケートを修正する</Btn></Card>
        </div>
        <div style={{ marginTop: 14 }}><Btn kind="ghost" onClick={() => goto("mine")}>自分の回答を確認</Btn></div>
      </div>
    );`);

replaceOnce("tests/page-routing.test.mjs", `  'tree: "/app/network"',`, `  'tree: "/app/tree"',`);
replaceOnce("tests/page-routing.test.mjs", `assert.equal((ui.match(/function viewFromPath\\(pathname\\)/g) || []).length, 1);`, `assert.equal((ui.match(/function viewFromPath\\(pathname\\)/g) || []).length, 1);\nassert.ok(ui.includes('const VIEW_PATH_ALIASES = { "/app/network": "tree" };'), "legacy /app/network route must remain a tree alias");`);
replaceOnce("cloudflare/tests/response-phase4-backend.test.mjs", `"0005_rate_limits.sql", "0006_response_access_revision.sql"]`, `"0005_rate_limits.sql", "0006_response_access_revision.sql", "0007_response_updated_at.sql"]`);
replaceOnce("cloudflare/tests/response-phase4-backend.test.mjs",
`test("pending current revision can be requeued with authorization", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  const r = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, {
    method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken },
    body: JSON.stringify({ expectedRevision: 1 })
  }), env);
  assert.equal(r.status, 202);
  assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);
  database.close();
});`,
`test("healthy pending current revision is not manually requeued", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  const r = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "ANALYSIS_NOT_RETRYABLE"); assert.deepEqual(queued, []); database.close();
});

test("failed current revision can be requeued without changing the response body", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  const before = database.prepare("SELECT free_text AS t, updated_at AS u FROM responses WHERE id=?").get(created.id);
  database.prepare("UPDATE responses SET analysis_status='failed' WHERE id=?").run(created.id);
  const r = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 202); assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);
  const after = database.prepare("SELECT free_text AS t, updated_at AS u, analysis_status AS s FROM responses WHERE id=?").get(created.id);
  assert.deepEqual([after.t, after.u, after.s], [before.t, before.u, "pending"]); database.close();
});

test("stalled pending current revision can be requeued", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json();
  database.prepare("UPDATE responses SET updated_at=? WHERE id=?").run(Date.now() - 120000, created.id);
  const r = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 202); assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]); database.close();
});

test("active running current revision is not manually requeued", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json(); const now = Date.now();
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'test','test','v','running',?,1,?)").run(created.id, now, now + 60000);
  const r = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "ANALYSIS_NOT_RETRYABLE"); assert.deepEqual(queued, []); database.close();
});

test("expired running current revision is requeued and its stale run is closed", async () => {
  const database = createDatabase(); const queued = [];
  const env = { DB: new D1(database), TURNSTILE_REQUIRED: "false", ANALYSIS_QUEUE: { send: async x => queued.push(x) } };
  const cr = await create(env, null); const created = await cr.json(); const now = Date.now();
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,response_revision,lease_until) VALUES (?,'test','test','v','running',?,1,?)").run(created.id, now - 120000, now - 1000);
  const r = await worker.fetch(new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, { method: "POST", headers: { "content-type": "application/json", "x-response-manage-token": created.manageToken }, body: JSON.stringify({ expectedRevision: 1 }) }), env);
  assert.equal(r.status, 202); assert.deepEqual(queued, [{ type: "analyze-response", responseId: created.id, revision: 1 }]);
  const oldRun = database.prepare("SELECT status,error_code AS errorCode FROM analysis_runs WHERE response_id=? ORDER BY id DESC LIMIT 1").get(created.id);
  assert.deepEqual([oldRun.status, oldRun.errorCode], ["failed", "LEASE_EXPIRED"]); database.close();
});`);
replaceOnce("cloudflare/tests/response-phase4-backend.test.mjs", `  const cr = await create(env, null); const created = await cr.json();
  const request = () => new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, {`, `  const cr = await create(env, null); const created = await cr.json();
  database.prepare("UPDATE responses SET analysis_status='failed' WHERE id=?").run(created.id);
  const request = () => new Request(\`http://local/api/responses/\${created.id}/analysis/requeue\`, {`);

for (const entry of fs.readdirSync(rel("cloudflare/tests"))) {
  if (!entry.endsWith(".mjs")) continue;
  const name = "cloudflare/tests/" + entry;
  let source = read(name);
  if (source.includes("0006_response_access_revision.sql") && !source.includes("0007_response_updated_at.sql")) {
    const quoted = /(["'])0006_response_access_revision\.sql\1/u;
    const match = source.match(quoted);
    if (!match) throw new Error("could not extend migration list in " + name);
    const quote = match[1];
    source = source.replace(quoted, match[0] + ", " + quote + "0007_response_updated_at.sql" + quote);
    write(name, source);
  }
}

write("tests/phase5-ui-contract.test.mjs", `import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nimport test from "node:test";\nconst ui = readFileSync(new URL("../core/ui.jsx", import.meta.url), "utf8");\ntest("Phase 5 canonical routes and compatibility alias", () => { assert.ok(ui.includes('tree: "/app/tree"')); assert.ok(ui.includes('quantum: "/app/quantum"')); assert.ok(ui.includes('const VIEW_PATH_ALIASES = { "/app/network": "tree" };')); assert.ok(ui.includes('const QUANTUM_PREVIEW_URL = "/quantum/')); });\ntest("Phase 5 auth lookup failure is not rendered as no response", () => { assert.ok(ui.includes("本人回答を確認できませんでした")); assert.ok(ui.includes("setSelfLookupError")); assert.ok(ui.includes("acctGet(session.name, cloudApiEnabled())")); });\ntest("Phase 5 response update operations are semantically separated", () => { assert.ok(ui.includes("現在の全文を残し、新しい段落を末尾へ追加")); assert.ok(ui.includes("現在の自由記述全文を置き換え")); assert.ok(ui.includes("初回回答時に保存された設問スナップショット")); assert.ok(ui.includes("currentResponse.cloudAnalysisRetryable === true")); });\ntest("Phase 5 typography restores historical body/display/mono roles without external font loading", () => { assert.ok(ui.includes('const FONT_BODY = \\'"Zen Kaku Gothic New"')); assert.ok(ui.includes('const FONT_DISP = \\'"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif\\';')); assert.ok(ui.includes('const FONT_MONO = \\'"IBM Plex Mono"')); assert.ok(!ui.includes("fonts.googleapis.com")); });\n`);

ensure("core/ui.jsx", 'tree: "/app/tree"');
ensure("core/ui.jsx", 'const VIEW_PATH_ALIASES = { "/app/network": "tree" };');
ensure("core/ui.jsx", 'quantum: "/app/quantum"');
ensure("core/ui.jsx", 'const QUANTUM_PREVIEW_URL = "/quantum/');
ensure("core/ui.jsx", 'const FONT_BODY = \'"Zen Kaku Gothic New"');
ensure("core/ui.jsx", 'const FONT_DISP = \'"Shippori Mincho"');
ensure("core/ui.jsx", 'const FONT_MONO = \'"IBM Plex Mono"');
ensure("core/ui.jsx", 'currentResponse.cloudAnalysisRetryable === true');
ensure("cloudflare/src/db.mjs", "ANALYSIS_STALL_AFTER_MS = 60000");
ensure("cloudflare/src/index.mjs", "ANALYSIS_NOT_RETRYABLE");
ensure("cloudflare/src/auth.mjs", "updatedAt");

if (dryRun) {
  console.log("Phase 5 anchor check passed. No files written (--check).");
  console.log("Validated buffered changes:", buffers.size, "files");
  process.exit(0);
}
for (const [name, value] of buffers) {
  fs.mkdirSync(path.dirname(rel(name)), { recursive: true });
  fs.writeFileSync(rel(name), value, "utf8");
}
run("node", ["scripts/build-app.mjs"]);
if (runTests) {
  run("node", ["tests/test.js"]);
  run("node", ["tests/page-routing.test.mjs"]);
  run("node", ["tests/phase5-ui-contract.test.mjs"]);
  run("node", ["tests/balcheck.js", "app/seiseki.jsx"]);
  run("npm", ["run", "check"], rel("cloudflare"));
  run("npm", ["test"], rel("cloudflare"));
  run("npm", ["run", "build"], rel("local"));
}
console.log("Phase 5 local implementation complete. External push/deploy/D1 actions were not performed.");
console.log(git("status", "--short"));
