import { requestAiAnalysis } from "../../src/analysis.mjs";
import { DEFAULT_QUESTIONS } from "../../src/config.mjs";

const MODELS = new Set([
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/mistralai/mistral-small-3.1-24b-instruct"
]);
const ANSWERS = Object.freeze({
  q_support: "わからない",
  q_priority: "その他",
  q_econ: "3",
  q_information: "わからない",
  q_social: "3",
  q_life: "わからない",
  q_participation: "わからない"
});

function authorized(request, env) {
  const expected = String(env.PROBE_TOKEN || "");
  return expected.length >= 24 && request.headers.get("x-probe-token") === expected;
}

function record() {
  return {
    age: "回答しない",
    gender: "回答しない",
    region: "回答しない",
    occupation: "回答しない",
    party: "支持政党なし",
    answers: Object.entries(ANSWERS).map(([qid, value]) => ({ qid, value })),
    questions: DEFAULT_QUESTIONS.filter(question => question.type !== "free").map((question, position) => ({
      qid: question.id,
      position,
      type: question.type,
      text: question.text,
      options: [...question.options],
      leftLabel: question.left || "",
      rightLabel: question.right || ""
    }))
  };
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) return Response.json({ error: "not_found" }, { status: 404 });
    if (request.method === "GET") return Response.json({ status: "ready" });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.json().catch(() => null);
    const model = String(body?.model || "");
    const scoringMode = body?.scoringMode === "distribution" ? "distribution" : "direct";
    const freeText = String(body?.freeText || "").slice(0, 1500);
    if (!MODELS.has(model) || !freeText) return Response.json({ error: "invalid_probe_input" }, { status: 400 });
    const startedAt = Date.now();
    let rawResult = null;
    const diagnosticEnv = {
      ...env,
      AI: {
        run: async (...args) => {
          rawResult = await env.AI.run(...args);
          return rawResult;
        }
      }
    };
    try {
      const result = await requestAiAnalysis(diagnosticEnv, model, record(), freeText, scoringMode);
      return Response.json({
        ok: true,
        model,
        scoringMode,
        durationMs: Date.now() - startedAt,
        attempts: result.attempts,
        analysis: result.analysis
      });
    } catch (error) {
      const content = rawResult?.choices?.[0]?.message?.content;
      const message = rawResult?.choices?.[0]?.message;
      const reasoning = typeof message?.reasoning === "string"
        ? message.reasoning
        : (typeof message?.reasoning_content === "string" ? message.reasoning_content : "");
      const text = typeof content === "string"
        ? content
        : JSON.stringify(content ?? rawResult?.response ?? "");
      return Response.json({
        ok: false,
        model,
        scoringMode,
        durationMs: Date.now() - startedAt,
        error: String(error?.message || error).slice(0, 240),
        syntheticOutputPreview: {
          length: text.length,
          head: text.slice(0, 500),
          tail: text.slice(-500)
        },
        syntheticResponseMeta: {
          messageKeys: message && typeof message === "object" ? Object.keys(message) : [],
          finishReason: rawResult?.choices?.[0]?.finish_reason ?? null,
          usage: rawResult?.usage ?? null,
          reasoningLength: reasoning.length
        }
      });
    }
  }
};
