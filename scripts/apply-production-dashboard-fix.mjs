import fs from "node:fs";

const uiFile = "core/ui.jsx";
const workerFile = "cloudflare/src/index.mjs";
let ui = fs.readFileSync(uiFile, "utf8");
let worker = fs.readFileSync(workerFile, "utf8");

const demoLoader = `async function cloudLoadDemoResponses() {
  if (!cloudApiEnabled()) return [];
  const payload = await cloudApiRequest("/api/demo-responses");
  return payload && Array.isArray(payload.responses) ? payload.responses : [];
}`;

const aggregateLoader = `${demoLoader}

async function cloudLoadPublicAggregate() {
  if (!cloudApiEnabled()) return null;
  const payload = await cloudApiRequest("/api/public-aggregate");
  if (!payload || typeof payload !== "object") return null;
  const base = newAgg();
  return {
    ...base,
    ...payload,
    demo: { ...base.demo, ...(payload.demo || {}) },
    questions: payload.questions || {},
    ideology: { ...base.ideology, ...(payload.ideology || {}), points: Array.isArray(payload.ideology && payload.ideology.points) ? payload.ideology.points : [] },
    topics: payload.topics || {},
    targets: payload.targets || {},
    cross: payload.cross || {},
    series: payload.series || {},
    rtree: payload.rtree || {},
    net: { ...base.net, ...(payload.net || {}), nodes: (payload.net && payload.net.nodes) || {}, links: (payload.net && payload.net.links) || {} },
    opinions: Array.isArray(payload.opinions) ? payload.opinions : []
  };
}`;

if (!ui.includes("async function cloudLoadPublicAggregate()")) {
  if (!ui.includes(demoLoader)) throw new Error("cloud demo loader marker not found");
  ui = ui.replace(demoLoader, aggregateLoader);
}

const oldInit = `      let demos = [];
      let cloudConfig = null;
      if (cloudApiEnabled()) {
        const [demoResult, configResult] = await Promise.allSettled([
          cloudLoadDemoResponses(),
          cloudLoadConfig()
        ]);
        if (demoResult.status === "fulfilled") demos = demoResult.value;
        else console.warn("cloud demo load failed", demoResult.reason);
        if (configResult.status === "fulfilled") cloudConfig = configResult.value;
        else console.warn("cloud config load failed", configResult.reason);
      }
      if (!alive) return;
      if (cloudConfig && cloudConfig.questions) setQuestions(cloudConfig.questions);
      else if (q) setQuestions(q);
      setPolicy(effectivePolicy);
      setCloudDemos(demos);
      setAgg(withCloudDemos(a || newAgg(), demos));`;

const newInit = `      let demos = [];
      let cloudConfig = null;
      let cloudAggregate = null;
      if (cloudApiEnabled()) {
        const [aggregateResult, demoResult, configResult] = await Promise.allSettled([
          cloudLoadPublicAggregate(),
          cloudLoadDemoResponses(),
          cloudLoadConfig()
        ]);
        if (aggregateResult.status === "fulfilled") cloudAggregate = aggregateResult.value;
        else console.warn("cloud aggregate load failed", aggregateResult.reason);
        if (demoResult.status === "fulfilled") demos = demoResult.value;
        else console.warn("cloud demo load failed", demoResult.reason);
        if (configResult.status === "fulfilled") cloudConfig = configResult.value;
        else console.warn("cloud config load failed", configResult.reason);
      }
      if (!alive) return;
      if (cloudConfig && cloudConfig.questions) setQuestions(cloudConfig.questions);
      else if (q) setQuestions(q);
      setPolicy(effectivePolicy);
      setCloudDemos(demos);
      const visibleAggregate = cloudAggregate || withCloudDemos(a || newAgg(), demos);
      setAgg(visibleAggregate);`;

if (ui.includes(oldInit)) ui = ui.replace(oldInit, newInit);
else if (!ui.includes("const visibleAggregate = cloudAggregate ||")) throw new Error("App aggregate initialization marker not found");

ui = ui.replace(
  `if (latest) setCompletion({ resp: latest, agg: withCloudDemos(a || newAgg(), demos) });`,
  `if (latest) setCompletion({ resp: latest, agg: cloudAggregate || withCloudDemos(a || newAgg(), demos) });`
);

const oldRefresh = `  async function refreshAgg() { const a = await sGet("agg:summary"); setAgg(withCloudDemos(a || newAgg(), cloudDemos)); }`;
const newRefresh = `  async function refreshAgg() {
    if (cloudApiEnabled()) {
      try {
        const remote = await cloudLoadPublicAggregate();
        if (remote) { setAgg(remote); return remote; }
      } catch (error) {
        console.warn("cloud aggregate refresh failed", error);
      }
    }
    const a = await sGet("agg:summary");
    const local = withCloudDemos(a || newAgg(), cloudDemos);
    setAgg(local);
    return local;
  }`;
if (ui.includes(oldRefresh)) ui = ui.replace(oldRefresh, newRefresh);
else if (!ui.includes("cloud aggregate refresh failed")) throw new Error("refreshAgg marker not found");

const oldGoView = `    if (currentPath() !== path) window.history.pushState({ view: v }, "", path);
    setView(v);`;
const newGoView = `    if (currentPath() !== path) window.history.pushState({ view: v }, "", path);
    setView(v);
    if (cloudApiEnabled() && ["home", "dash", "tree", "opinions"].includes(v)) {
      refreshAgg().catch(error => console.warn("aggregate navigation refresh failed", error));
    }`;
if (ui.includes(oldGoView)) ui = ui.replace(oldGoView, newGoView);
else if (!ui.includes("aggregate navigation refresh failed")) throw new Error("goView refresh marker not found");

if (!worker.includes('from "./public-aggregate.mjs"')) {
  worker = worker.replace(
    'import { enforceRateLimit, RATE_LIMIT_POLICIES } from "./rate-limit.mjs";',
    'import { enforceRateLimit, RATE_LIMIT_POLICIES } from "./rate-limit.mjs";\nimport { getPublicAggregate } from "./public-aggregate.mjs";'
  );
}

const statsRoute = `  if (request.method === "GET" && url.pathname === "/api/stats") {
    return json(await getBasicStats(env.DB), 200, { "cache-control": "public, max-age=0, s-maxage=60" });
  }`;
const aggregateRoute = `${statsRoute}
  if (request.method === "GET" && url.pathname === "/api/public-aggregate") {
    return json(await getPublicAggregate(env.DB), 200, { "cache-control": "public, max-age=0, s-maxage=30" });
  }`;
if (!worker.includes('url.pathname === "/api/public-aggregate"')) {
  if (!worker.includes(statsRoute)) throw new Error("stats route marker not found");
  worker = worker.replace(statsRoute, aggregateRoute);
}

for (const marker of [
  "async function cloudLoadPublicAggregate()",
  'cloudApiRequest("/api/public-aggregate")',
  "const visibleAggregate = cloudAggregate ||",
  "cloud aggregate refresh failed",
  'url.pathname === "/api/public-aggregate"',
  "getPublicAggregate(env.DB)"
]) {
  if (!ui.includes(marker) && !worker.includes(marker)) throw new Error(`missing dashboard hotfix marker: ${marker}`);
}

fs.writeFileSync(uiFile, ui);
fs.writeFileSync(workerFile, worker);
console.log("production dashboard D1 aggregate hotfix applied");
