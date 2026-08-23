import fs from "node:fs";

const file = "cloudflare/wrangler.jsonc";
const databaseId = String(process.env.SEISEKI_PRODUCTION_D1_ID || "").trim();
if (!/^[0-9a-f-]{36}$/i.test(databaseId)) throw new Error("SEISEKI_PRODUCTION_D1_ID is missing or invalid");

const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.name = "seiseki-api";
config.workers_dev = true;
config.d1_databases = [{
  binding: "DB",
  database_name: "seiseki-db",
  database_id: databaseId,
  migrations_dir: "migrations"
}];
config.ai = { binding: "AI" };
config.queues = {
  producers: [{ binding: "ANALYSIS_QUEUE", queue: "seiseki-analysis" }],
  consumers: [{
    queue: "seiseki-analysis",
    max_batch_size: 3,
    max_batch_timeout: 2,
    max_retries: 3,
    max_concurrency: 1,
    retry_delay: 10
  }]
};
config.vars = {
  TURNSTILE_REQUIRED: "false",
  ALLOWED_ORIGINS: "https://seiseki-api.tokyo-odh-129.workers.dev",
  AI_ANALYSIS_ENABLED: "true",
  AI_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8",
  AI_MAX_ATTEMPTS: "2",
  AI_MAX_OUTPUT_TOKENS: "1800",
  PASSWORD_ITERATIONS: "120000"
};

fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
console.log(`production config prepared for D1 ${databaseId}`);
