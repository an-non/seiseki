import { readFileSync, writeFileSync } from "node:fs";

const testPath = "cloudflare/tests/staging-admin.test.mjs";
let testSource = readFileSync(testPath, "utf8");
const oldList = '"0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_questionnaire_seven_structured.sql"';
const newList = '"0006_response_access_revision.sql", "0007_response_updated_at.sql", "0008_response_follow_up_text.sql", "0008_questionnaire_seven_structured.sql"';
if (!testSource.includes(oldList)) throw new Error("staging-admin migration list no longer matches audited source");
testSource = testSource.replace(oldList, newList);
writeFileSync(testPath, testSource, "utf8");

const migration = readFileSync("cloudflare/migrations/0008_questionnaire_seven_structured.sql", "utf8");
if (!migration.includes("q_information") || !migration.includes("q_social") || !migration.includes("q_life") || !migration.includes("q_participation")) {
  throw new Error("seven-question migration does not contain the audited question set");
}

const admin = readFileSync("cloudflare/src/staging-admin.mjs", "utf8");
if (!admin.includes('SEISEKI_ENV') || !admin.includes('STAGING_ADMIN_ENABLED') || !admin.includes('x-seiseki-admin-token')) {
  throw new Error("staging admin lost staging-only or token guard");
}

console.log("selective Base-Yuki files adapted without provisional analysis path");
