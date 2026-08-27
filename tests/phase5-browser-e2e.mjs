import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../cloudflare/src/index.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(ROOT, "local", "dist");
const ARTIFACTS = join(ROOT, "phase5-browser-e2e-artifacts");
const ORIGIN = "https://127.0.0.1:4175";
const CDP_PORT = 9000 + (process.pid % 1000);
const PASSWORD = "phase5-e2e-password-20260827";

mkdirSync(ARTIFACTS, { recursive: true });
assert.ok(existsSync(join(DIST, "index.html")), "local/dist/index.html is required; build the local app first");

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { const next = new Statement(this.database, this.sql); next.values = values; return next; }
  first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  run() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}

class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(statement => statement.run());
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const name of [
    "0001_initial.sql",
    "0002_accounts_and_analysis.sql",
    "0003_staging_kdf_range.sql",
    "0004_response_question_context.sql",
    "0005_rate_limits.sql",
    "0006_response_access_revision.sql",
    "0007_response_updated_at.sql"
  ]) {
    database.exec(readFileSync(join(ROOT, "cloudflare", "migrations", name), "utf8"));
  }
  return database;
}

const database = createDatabase();
const queueErrors = [];
const queueEvents = [];

const env = {
  DB: new D1(database),
  TURNSTILE_REQUIRED: "false",
  AI_ANALYSIS_ENABLED: "true",
  AUTH_PBKDF2_ITERATIONS: "30000",
  ALLOWED_ORIGINS: ORIGIN,
  AI: {
    run: async () => ({
      response: JSON.stringify({
        params: { emo: { pol: 0, label: "中立" }, valid: 72, crit: 48, motiv: 61 },
        ideology: { econ: 0.1, soc: -0.1, confidence: 40 },
        attrs: [],
        chunks: []
      })
    })
  }
};

async function consumeQueue(body) {
  queueEvents.push({ at: Date.now(), body });
  await worker.queue({
    messages: [{
      id: randomUUID(),
      body,
      ack() {},
      retry(options) { throw new Error("unexpected queue retry: " + JSON.stringify(options || {})); }
    }]
  }, env);
}

env.ANALYSIS_QUEUE = {
  async send(body) {
    setTimeout(() => {
      consumeQueue(body).catch(error => queueErrors.push(error));
    }, 60);
  }
};

function mime(path) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".bin": "application/octet-stream"
  })[extname(path).toLowerCase()] || "application/octet-stream";
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const absolute = resolve(DIST, relative || "index.html");
  if (!absolute.startsWith(resolve(DIST))) return null;
  return absolute;
}

async function readNodeBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function handleApi(req, res) {
  const body = await readNodeBody(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  headers.set("origin", ORIGIN);
  headers.set("cf-connecting-ip", "127.0.0.1");
  const init = { method: req.method, headers };
  if (body.length && req.method !== "GET" && req.method !== "HEAD") init.body = body;
  const waits = [];
  const response = await worker.fetch(new Request(ORIGIN + req.url, init), env, {
    waitUntil(promise) { waits.push(Promise.resolve(promise)); }
  });
  const responseBody = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(responseBody);
  void Promise.allSettled(waits);
}

function makeCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "seiseki-phase5-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1"
  ], { stdio: "ignore" });
  assert.equal(result.status, 0, "openssl must be available to create the local HTTPS certificate");
  return { dir, key: readFileSync(key), cert: readFileSync(cert) };
}

const certificate = makeCertificate();
const server = https.createServer({ key: certificate.key, cert: certificate.cert }, async (req, res) => {
  try {
    const path = new URL(req.url, ORIGIN).pathname;
    if (path.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    let file = safeStaticPath(path);
    if (!file || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
    res.end(readFileSync(file));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(error?.stack || error));
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(4175, "127.0.0.1", resolveListen);
});

function commandPath(name) {
  if (!name) return null;
  if (name.includes("/") && existsSync(name)) return name;
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const chromePath = [process.env.CHROME_BIN, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  .map(commandPath)
  .find(Boolean);
assert.ok(chromePath, "Chrome/Chromium executable was not found");

const chromeProfile = mkdtempSync(join(tmpdir(), "seiseki-phase5-chrome-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--ignore-certificate-errors",
  "--allow-insecure-localhost",
  "--enable-webgl",
  "--use-angle=swiftshader",
  `--user-data-dir=${chromeProfile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });

let chromeStderr = "";
chrome.stderr.on("data", chunk => { chromeStderr += String(chunk); });

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

async function waitHttp(url, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { return await fetch(url); } catch (error) { last = error; await sleep(100); }
  }
  throw last || new Error("timed out waiting for " + url);
}

await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
const pageInfo = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(ORIGIN + "/app")}`, { method: "PUT" })).json();
assert.ok(pageInfo.webSocketDebuggerUrl, "CDP websocket URL is required");

class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.ws.addEventListener("open", resolveOpen, { once: true });
      this.ws.addEventListener("error", rejectOpen, { once: true });
    });
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { if (this.ws) this.ws.close(); }
}

const cdp = new CDP(pageInfo.webSocketDebuggerUrl);
await cdp.open();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "browser evaluation failed");
  return result.result.value;
}

async function waitForExpression(expression, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
      last = value;
    } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}; last=${String(last)}`);
}

async function waitReady(pathname) {
  await waitForExpression(`location.pathname === ${JSON.stringify(pathname)} && document.readyState === "complete" && document.body.innerText.trim().length > 0`, `route ${pathname}`);
}

async function navigate(pathname) {
  await cdp.send("Page.navigate", { url: ORIGIN + pathname });
  await waitReady(pathname);
}

async function reload(pathname) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitReady(pathname);
}

async function bodyText() { return evaluate("document.body.innerText"); }

async function clickText(text, exact = true) {
  const payload = JSON.stringify(text);
  const result = await evaluate(`(() => {
    const wanted = ${payload};
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const nodes = [...document.querySelectorAll('button,[role="button"],a')].filter(visible);
    const target = nodes.find(el => {
      const t = (el.textContent || '').trim();
      return ${exact ? "t === wanted" : "t.includes(wanted)"};
    });
    if (!target) return { ok: false, available: nodes.map(x => (x.textContent || '').trim()).filter(Boolean).slice(0, 80) };
    target.click();
    return { ok: true, text: (target.textContent || '').trim() };
  })()`);
  assert.equal(result.ok, true, `button/text not found: ${text}; available=${JSON.stringify(result.available || [])}`);
}

async function fillByPlaceholder(fragment, value) {
  const result = await evaluate(`(() => {
    const fragment = ${JSON.stringify(fragment)};
    const value = ${JSON.stringify(value)};
    const el = [...document.querySelectorAll('input,textarea')].find(node => (node.placeholder || '').includes(fragment) && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(result, true, `input placeholder not found: ${fragment}`);
}

async function fillPassword(value) {
  const count = await evaluate(`(() => {
    const visible = [...document.querySelectorAll('input[type="password"]')].filter(node => node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    for (const el of visible) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return visible.length;
  })()`);
  assert.ok(count >= 1, "visible password input was not found");
}

async function fillVisibleTextarea(value) {
  const result = await evaluate(`(() => {
    const el = [...document.querySelectorAll('textarea')].find(node => node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(result, true, "visible textarea was not found");
}

async function waitDb(predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = predicate();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(80);
  }
  throw new Error(`Timed out waiting for DB: ${description}; last=${String(last)}`);
}

function currentResponse() {
  return database.prepare("SELECT id, revision, free_text AS freeText, analysis_status AS analysisStatus, updated_at AS updatedAt FROM responses ORDER BY created_at DESC LIMIT 1").get() || null;
}

function answerValue(responseId, qid) {
  return database.prepare("SELECT value FROM answers WHERE response_id=? AND qid=?").get(responseId, qid)?.value || null;
}

async function assertRouteReload(pathname) {
  await navigate(pathname);
  assert.equal(await evaluate("location.pathname"), pathname);
  await reload(pathname);
  assert.equal(await evaluate("location.pathname"), pathname);
  assert.ok((await bodyText()).trim().length > 40, `${pathname} rendered too little content`);
}

const report = {
  origin: ORIGIN,
  chrome: chromePath,
  routes: [],
  revisions: [],
  fonts: {},
  screenshots: {},
  queueEvents: 0
};

try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  for (const pathname of ["/app", "/app/dashboard", "/app/tree", "/app/quantum"]) {
    await assertRouteReload(pathname);
    report.routes.push({ pathname, unauthenticated: true, reload: true });
    const text = await bodyText();
    assert.ok(!text.includes("回答にはログイン"), `${pathname} must stay publicly readable`);
  }

  await navigate("/app/quantum");
  await waitForExpression(`(() => {
    const frame = document.querySelector('iframe[src^="/quantum/"]');
    return !!(frame && frame.contentDocument && frame.contentDocument.readyState === 'complete' && frame.contentDocument.querySelector('canvas'));
  })()`, "same-origin quantum iframe canvas", 15000);
  const quantum = await evaluate(`(() => {
    const frame = document.querySelector('iframe[src^="/quantum/"]');
    return { src: frame?.getAttribute('src') || '', sameOrigin: !!frame?.contentDocument, canvas: !!frame?.contentDocument?.querySelector('canvas') };
  })()`);
  assert.ok(quantum.src.startsWith("/quantum/chunk-network-entanglement-preview.html"));
  assert.equal(quantum.sameOrigin, true);
  assert.equal(quantum.canvas, true);

  await navigate("/app");
  await navigate("/app/tree");
  await navigate("/app/quantum");
  await evaluate("history.back(); true");
  await waitForExpression(`location.pathname === "/app/tree"`, "browser back to tree");
  await evaluate("history.forward(); true");
  await waitForExpression(`location.pathname === "/app/quantum"`, "browser forward to quantum");

  await navigate("/survey");
  await waitForExpression(`document.body.innerText.includes("回答にはログイン")`, "survey auth gate");
  const accountName = "phase5e2e" + Date.now().toString(36);
  await fillByPlaceholder("川辺の亀", accountName);
  await fillPassword(PASSWORD);
  await clickText("登録して回答へ進む");
  await waitForExpression(`document.body.innerText.includes("回答の前にご確認ください")`, "survey consent after registration");

  const checked = await evaluate(`(() => { const el = document.querySelector('input[type="checkbox"]'); if (!el) return false; el.click(); return true; })()`);
  assert.equal(checked, true);
  await clickText("同意して回答をはじめる");
  await waitForExpression(`document.body.innerText.includes("あなたについて教えてください")`, "demographic phase");

  const demoGroups = await evaluate(`(() => {
    const h2 = [...document.querySelectorAll('h2')].find(el => (el.textContent || '').includes('あなたについて教えてください'));
    if (!h2) return 0;
    const root = h2.parentElement?.parentElement;
    return [...root.children].filter(child => {
      const buttons = [...child.querySelectorAll('button')].filter(b => b.offsetWidth || b.offsetHeight || b.getClientRects().length);
      if (buttons.length < 2) return false;
      const texts = buttons.map(b => (b.textContent || '').trim());
      return !texts.includes('戻る') && !texts.includes('次へ');
    }).length;
  })()`);
  assert.ok(demoGroups >= 4, `expected demographic button groups, found ${demoGroups}`);
  for (let index = 0; index < demoGroups; index += 1) {
    const clicked = await evaluate(`(() => {
      const h2 = [...document.querySelectorAll('h2')].find(el => (el.textContent || '').includes('あなたについて教えてください'));
      const root = h2?.parentElement?.parentElement;
      if (!root) return false;
      const groups = [...root.children].filter(child => {
        const buttons = [...child.querySelectorAll('button')].filter(b => b.offsetWidth || b.offsetHeight || b.getClientRects().length);
        if (buttons.length < 2) return false;
        const texts = buttons.map(b => (b.textContent || '').trim());
        return !texts.includes('戻る') && !texts.includes('次へ');
      });
      const button = groups[${index}]?.querySelector('button');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, `demographic group ${index} could not be selected`);
    await sleep(60);
  }
  await clickText("次へ");

  const firstFreeText = "Phase 5 browser E2E 初回自由記述。行政サービス改善と情報公開の充実を希望します。";
  for (let safety = 0; safety < 20; safety += 1) {
    await waitForExpression(`/Q\\d+ \\/ \\d+/.test(document.body.innerText) || document.body.innerText.includes("解析")`, "survey question or analysis phase");
    const state = await evaluate(`(() => {
      const m = document.body.innerText.match(/Q(\\d+) \\/ (\\d+)/);
      return { q: m ? Number(m[1]) : 0, total: m ? Number(m[2]) : 0, hasTextarea: !![...document.querySelectorAll('textarea')].find(n => n.offsetWidth || n.offsetHeight || n.getClientRects().length), submit: [...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('AI解析して送信') && !b.disabled) };
    })()`);
    if (!state.q) break;
    if (state.hasTextarea) {
      await fillVisibleTextarea(firstFreeText);
    } else {
      const selected = await evaluate(`(() => {
        const h2 = [...document.querySelectorAll('h2')].find(el => el.previousElementSibling && /Q\\d+ \\/ \\d+/.test(el.previousElementSibling.textContent || ''));
        const root = h2?.parentElement;
        if (!root) return false;
        const options = [...root.querySelectorAll('button')].filter(b => {
          const text = (b.textContent || '').trim();
          return (b.offsetWidth || b.offsetHeight || b.getClientRects().length) && !['戻る','次へ','AI解析して送信','端末内で解析して保存'].includes(text);
        });
        if (!options.length) return false;
        options[0].click();
        return true;
      })()`);
      assert.equal(selected, true, `question ${state.q} option was not selectable`);
      await sleep(50);
    }
    const submitVisible = await evaluate(`[...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('AI解析して送信') && !b.disabled)`);
    if (submitVisible) {
      await clickText("AI解析して送信");
      break;
    }
    await clickText("次へ");
  }

  const initial = await waitDb(() => {
    const row = currentResponse();
    return row && row.revision === 1 && row.analysisStatus === "completed" ? row : null;
  }, "initial response completed", 15000);
  assert.ok(initial.freeText.includes("Phase 5 browser E2E"));
  report.revisions.push({ phase: "initial", revision: initial.revision, status: initial.analysisStatus });

  await navigate("/survey");
  await waitForExpression(`document.body.innerText.includes("回答を更新する") && document.body.innerText.includes("AI解析完了")`, "current response completed UI");
  assert.ok(!(await bodyText()).includes("現在revisionの解析を再試行"), "retry must not be visible for completed analysis");

  await clickText("追記する");
  await waitForExpression(`document.querySelector('textarea[placeholder*="追加したい内容"]') !== null`, "append editor");
  const appendText = "追記E2E: 地方自治体のデジタル手続きをさらに分かりやすくしてほしい。";
  await fillByPlaceholder("追加したい内容", appendText);
  await clickText("保存して再解析");
  const appended = await waitDb(() => {
    const row = currentResponse();
    return row && row.revision === 2 && row.analysisStatus === "completed" ? row : null;
  }, "append revision completed", 15000);
  assert.ok(appended.freeText.includes(firstFreeText));
  assert.ok(appended.freeText.includes(appendText));
  report.revisions.push({ phase: "append", revision: appended.revision, status: appended.analysisStatus });
  await waitForExpression(`document.body.innerText.includes("revision 2") && document.body.innerText.includes("AI解析完了")`, "append UI completion");

  await clickText("全文を修正する");
  await waitForExpression(`document.querySelector('textarea[placeholder*="現在の自由記述を編集"]') !== null`, "full edit editor");
  const replacementText = "全文修正E2E: 行政サービスは透明性と利用しやすさを優先し、説明責任を強化してほしい。";
  await fillByPlaceholder("現在の自由記述を編集", replacementText);
  await clickText("保存して再解析");
  const edited = await waitDb(() => {
    const row = currentResponse();
    return row && row.revision === 3 && row.analysisStatus === "completed" ? row : null;
  }, "full edit revision completed", 15000);
  assert.equal(edited.freeText, replacementText);
  assert.ok(!edited.freeText.includes(appendText));
  report.revisions.push({ phase: "full-edit", revision: edited.revision, status: edited.analysisStatus });
  await waitForExpression(`document.body.innerText.includes("revision 3") && document.body.innerText.includes("AI解析完了")`, "full edit UI completion");

  await clickText("アンケートを修正する");
  await waitForExpression(`document.body.innerText.includes("アンケート回答を修正")`, "answer editor");
  await clickText("支持しない");
  await clickText("保存して再解析");
  const answerEdited = await waitDb(() => {
    const row = currentResponse();
    return row && row.revision === 4 && row.analysisStatus === "completed" ? row : null;
  }, "answer edit revision completed", 15000);
  assert.equal(answerValue(answerEdited.id, "q_support"), "支持しない");
  assert.equal(answerEdited.freeText, replacementText, "answer edit must not change free text");
  report.revisions.push({ phase: "answer-edit", revision: answerEdited.revision, status: answerEdited.analysisStatus });
  await waitForExpression(`document.body.innerText.includes("revision 4") && document.body.innerText.includes("AI解析完了")`, "answer edit UI completion");

  database.prepare("UPDATE responses SET analysis_status='pending', analysis_json=NULL, updated_at=? WHERE id=?").run(Date.now(), answerEdited.id);
  await reload("/survey");
  await waitForExpression(`document.body.innerText.includes("AI解析待ち")`, "healthy pending UI");
  assert.ok(!(await bodyText()).includes("現在revisionの解析を再試行"), "healthy pending analysis must not offer retry");

  const failAt = Date.now();
  database.prepare("UPDATE responses SET analysis_status='failed', analysis_json=NULL WHERE id=?").run(answerEdited.id);
  database.prepare("INSERT INTO analysis_runs (response_id,engine,model,prompt_version,status,started_at,completed_at,error_code,response_revision) VALUES (?,'e2e','e2e','phase5','failed',?,?,?,?)")
    .run(answerEdited.id, failAt - 500, failAt, "E2E_FORCED_FAILURE", answerEdited.revision);
  await reload("/survey");
  await waitForExpression(`document.body.innerText.includes("AI解析に失敗") && document.body.innerText.includes("現在revisionの解析を再試行")`, "failed fixture retry UI");
  const beforeRetryText = currentResponse().freeText;
  await clickText("現在revisionの解析を再試行");
  const retried = await waitDb(() => {
    const row = currentResponse();
    return row && row.revision === 4 && row.analysisStatus === "completed" ? row : null;
  }, "failed fixture retry completed", 15000);
  assert.equal(retried.freeText, beforeRetryText);
  assert.equal(retried.revision, 4, "retry must not increment response revision");
  report.revisions.push({ phase: "failed-retry", revision: retried.revision, status: retried.analysisStatus });
  await waitForExpression(`document.body.innerText.includes("revision 4") && document.body.innerText.includes("AI解析完了")`, "retry UI completion");

  for (const pathname of ["/app", "/app/dashboard", "/app/tree", "/app/quantum", "/survey", "/account/response"]) {
    await assertRouteReload(pathname);
    report.routes.push({ pathname, authenticated: true, reload: true });
  }

  await navigate("/app/quantum");
  await reload("/app/quantum");
  await waitForExpression(`document.querySelector('iframe[src^="/quantum/"]')?.contentDocument?.querySelector('canvas') !== null`, "authenticated quantum after reload", 15000);

  async function capture(name, pathname, metrics) {
    await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
    await navigate(pathname);
    await sleep(250);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const bytes = Buffer.from(shot.data, "base64");
    assert.ok(bytes.length > 5000, `${name} screenshot is unexpectedly small`);
    const file = join(ARTIFACTS, name + ".png");
    writeFileSync(file, bytes);
    assert.equal(bytes.toString("ascii", 1, 4), "PNG");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    report.screenshots[name] = { pathname, bytes: bytes.length, width, height, sha256: createHash("sha256").update(bytes).digest("hex") };
    return file;
  }

  await capture("desktop-app", "/app", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await capture("desktop-survey", "/survey", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await capture("mobile-app", "/app", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture("mobile-survey", "/survey", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.notEqual(report.screenshots["desktop-app"].sha256, report.screenshots["mobile-app"].sha256, "desktop/mobile app screenshots should differ");

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await navigate("/app");
  const fonts = await evaluate(`(() => {
    const root = document.getElementById('root')?.firstElementChild;
    const heading = document.querySelector('h1,h2');
    const all = [...document.querySelectorAll('*')];
    const mono = all.find(el => getComputedStyle(el).fontFamily.includes('IBM Plex Mono'));
    return {
      body: root ? getComputedStyle(root).fontFamily : '',
      display: heading ? getComputedStyle(heading).fontFamily : '',
      mono: mono ? getComputedStyle(mono).fontFamily : '',
      shipporiLoaded: document.fonts.check('16px "Shippori Mincho"'),
      zenLoaded: document.fonts.check('16px "Zen Kaku Gothic New"')
    };
  })()`);
  assert.ok(fonts.body.includes("Zen Kaku Gothic New"), `body font role not restored: ${fonts.body}`);
  assert.ok(fonts.display.includes("Shippori Mincho"), `display font role not restored: ${fonts.display}`);
  assert.ok(fonts.mono.includes("IBM Plex Mono"), `mono font role not restored: ${fonts.mono}`);
  assert.notEqual(fonts.body, fonts.display, "body and display font roles must remain distinct");
  report.fonts = fonts;

  assert.equal(queueErrors.length, 0, queueErrors.map(error => error?.stack || String(error)).join("\n"));
  report.queueEvents = queueEvents.length;
  report.database = {
    responses: database.prepare("SELECT count(*) AS n FROM responses").get().n,
    analysisRuns: database.prepare("SELECT count(*) AS n FROM analysis_runs").get().n,
    opinionChunks: database.prepare("SELECT count(*) AS n FROM opinion_chunks").get().n,
    current: currentResponse()
  };
  assert.equal(report.database.responses, 1);
  assert.equal(report.database.current.revision, 4);
  assert.equal(report.database.current.analysisStatus, "completed");

  writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("Phase 5 browser E2E PASS");
  console.log(JSON.stringify(report, null, 2));
} finally {
  cdp.close();
  chrome.kill("SIGTERM");
  server.close();
  database.close();
  rmSync(certificate.dir, { recursive: true, force: true });
  // Hosted Chrome can still be flushing its profile after SIGTERM; the runner is ephemeral.
  if (chrome.exitCode && chrome.exitCode !== 0) console.error(chromeStderr.slice(-4000));
}
