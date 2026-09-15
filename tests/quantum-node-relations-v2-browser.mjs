import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const URL = process.env.QUANTUM_V2_URL
  || "http://127.0.0.1:4176/quantum-node-relations-v2-preview.html?count=5000&theme=dark";
const EDGE = process.env.EDGE_BIN
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9300 + (process.pid % 500);
const ARTIFACTS = resolve("quantum-node-relations-v2-browser-artifacts");
const profile = mkdtempSync(join(tmpdir(), "seiseki-quantum-v2-edge-"));

assert.ok(existsSync(EDGE), `Edge executable was not found: ${EDGE}`);
mkdirSync(ARTIFACTS,{ recursive:true });

const browser = spawn(EDGE, [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu-sandbox",
  "--enable-webgl",
  "--use-angle=swiftshader",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  "about:blank"
], { stdio:["ignore","pipe","pipe"] });

let browserErrors = "";
browser.stderr.on("data", chunk => { browserErrors += String(chunk); });
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep,milliseconds));

async function waitHttp(url,timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { return await fetch(url); }
    catch (error) { lastError = error; await sleep(100); }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

class CDP {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
  }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen,rejectOpen) => {
      this.socket.addEventListener("open",resolveOpen,{ once:true });
      this.socket.addEventListener("error",rejectOpen,{ once:true });
    });
    this.socket.addEventListener("message",event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") this.exceptions.push(message.params);
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }
  send(method,params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend,rejectSend) => {
      this.pending.set(id,{ resolve:resolveSend,reject:rejectSend });
      this.socket.send(JSON.stringify({ id,method,params }));
    });
  }
  close() { this.socket?.close(); }
}

let cdp;
try {
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const page = await (await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(URL)}`,
    { method:"PUT" }
  )).json();
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate",{
      expression,awaitPromise:true,returnByValue:true,userGesture:true
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
        || result.result?.description
        || result.exceptionDetails.text
        || "Browser evaluation failed"
      );
    }
    return result.result.value;
  }
  async function waitFor(expression,label,timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function capture(name,metrics) {
    await cdp.send("Emulation.setDeviceMetricsOverride",metrics);
    await evaluate("window.__QUANTUM_NODE_RELATIONS_V2__ = null");
    await cdp.send("Page.reload",{ ignoreCache:true });
    await waitFor(`innerWidth === ${metrics.width} && window.__QUANTUM_NODE_RELATIONS_V2__?.opinionCount === 5000 && window.__QUANTUM_NODE_RELATIONS_V2__?.canvasProbe?.sampleColors >= 8`,"v2 network");
    await sleep(300);
    const layout = await evaluate(`(() => {
      const canvas = document.querySelector('canvas');
      const controls = document.querySelector('.controls').getBoundingClientRect();
      const details = document.querySelector('.details').getBoundingClientRect();
      return {
        canvas:{ width:canvas.width,height:canvas.height },
        controls:{ top:controls.top,bottom:controls.bottom },
        details:{ top:details.top,bottom:details.bottom },
        viewport:{ width:innerWidth,height:innerHeight },
        sampleColors:window.__QUANTUM_NODE_RELATIONS_V2__.canvasProbe.sampleColors,
        nonBackground:window.__QUANTUM_NODE_RELATIONS_V2__.canvasProbe.variedPixels,
        noticeVisible:getComputedStyle(document.getElementById('notice')).display !== 'none',
        state:window.__QUANTUM_NODE_RELATIONS_V2__
      };
    })()`);
    assert.equal(layout.noticeVisible,false);
    assert.equal(layout.state.opinionCount,5000);
    assert.equal(layout.state.quantumNodeCount,72);
    assert.ok(layout.state.relationCount > 0 && layout.state.relationCount <= 180);
    assert.ok(layout.state.derivedNodeCount > 0 && layout.state.derivedNodeCount <= 24);
    assert.ok(layout.sampleColors >= 8,`canvas has too few sampled colors: ${layout.sampleColors}`);
    assert.ok(layout.nonBackground >= 8,`canvas appears blank: ${layout.nonBackground}`);
    assert.ok(layout.controls.bottom <= layout.details.top || metrics.mobile);
    const screenshot = await cdp.send("Page.captureScreenshot",{ format:"png",fromSurface:true });
    const bytes = Buffer.from(screenshot.data,"base64");
    assert.ok(bytes.length > 10000,`${name} screenshot is unexpectedly small`);
    const path = join(ARTIFACTS,`${name}.png`);
    writeFileSync(path,bytes);
    return {
      ...layout,
      screenshot:{ path,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex") }
    };
  }

  const desktop = await capture("desktop",{
    width:1280,height:800,deviceScaleFactor:1,mobile:false
  });
  const mobile = await capture("mobile",{
    width:390,height:844,deviceScaleFactor:1,mobile:true
  });
  assert.notEqual(desktop.screenshot.sha256,mobile.screenshot.sha256);

  await cdp.send("Emulation.setDeviceMetricsOverride",{
    width:1280,height:800,deviceScaleFactor:1,mobile:false
  });
  await evaluate("window.__QUANTUM_NODE_RELATIONS_V2__ = null");
  await cdp.send("Page.reload",{ ignoreCache:true });
  await waitFor("innerWidth === 1280 && window.__QUANTUM_NODE_RELATIONS_V2__?.opinionCount === 5000 && window.__QUANTUM_NODE_RELATIONS_V2__?.canvasProbe?.sampleColors >= 8","interactive v2 network");
  const initial = await evaluate("window.__QUANTUM_NODE_RELATIONS_V2__");
  await evaluate("document.querySelector('[data-basis=urgency]').click()");
  await waitFor("window.__QUANTUM_NODE_RELATIONS_V2__?.basis === 'urgency'","urgency basis");
  const changedBasis = await evaluate("window.__QUANTUM_NODE_RELATIONS_V2__");
  assert.equal(changedBasis.epoch,initial.epoch);
  await evaluate("document.getElementById('observe').click()");
  await waitFor(`window.__QUANTUM_NODE_RELATIONS_V2__?.epoch === ${initial.epoch + 1}`,"next epoch");
  const observed = await evaluate("window.__QUANTUM_NODE_RELATIONS_V2__");
  assert.equal(observed.basis,"urgency");
  assert.equal(observed.epoch,initial.epoch + 1);
  assert.equal(cdp.exceptions.length,0,JSON.stringify(cdp.exceptions));

  const report = { url:URL,desktop,mobile,initial,changedBasis,observed };
  writeFileSync(join(ARTIFACTS,"report.json"),`${JSON.stringify(report,null,2)}\n`);
  console.log("Quantum node relations v2 browser PASS");
  console.log(JSON.stringify({
    desktop:desktop.screenshot,
    mobile:mobile.screenshot,
    canvas:{ desktop:desktop.sampleColors,mobile:mobile.sampleColors },
    state:observed
  },null,2));
} finally {
  cdp?.close();
  browser.kill("SIGTERM");
  if (browser.exitCode && browser.exitCode !== 0) console.error(browserErrors.slice(-2000));
}
