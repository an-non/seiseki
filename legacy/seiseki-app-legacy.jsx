import React, { useState, useEffect, useMemo } from "react";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar,
  ScatterChart, Scatter, ReferenceLine, ZAxis,
} from "recharts";
import {
  ClipboardList, BarChart3, Settings, ShieldCheck, Send, Plus, Trash2,
  Download, Database, AlertTriangle, CheckCircle2, Loader2, Users,
  MessageSquare, Target, Sparkles, ChevronDown, Activity, Filter, X,
  Lock, Info, RotateCcw, Layers, Flame, Compass,
} from "lucide-react";

/* ============================================================
   声析 (SEISEKI) — 政治意見 定量化プラットフォーム (プロトタイプ)
   - アンケート回答をAIで多次元パラメータ化しDBへ蓄積
   - 意見チャンク抽出 / 不満の対象別集計 / 統計ダッシュボード
   ============================================================ */

/* ---------- デザイントークン ---------- */
const P = {
  bg: "#f3f5f7",
  grid: "#e3e8ee",
  paper: "#ffffff",
  ink: "#1a2432",
  sub: "#5b6674",
  faint: "#8a94a0",
  line: "#d9dfe6",
  indigo: "#2b5d8c",
  indigoDeep: "#1e4266",
  indigoSoft: "#e8eff6",
  vermilion: "#c23a2b",
  vermilionSoft: "#f7e8e5",
  gold: "#b9862c",
  goldSoft: "#f6efdf",
  green: "#3f7d5c",
  greenSoft: "#e7f1ea",
  neutral: "#8a94a0",
};
const SERIF = '"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP","BIZ UDMincho",serif';
const SANS = '"Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",-apple-system,"Segoe UI",sans-serif';

const GROUP_COLORS = { 支持: P.indigo, 中立: P.neutral, 不支持: P.vermilion, 未回答: "#c8ced6" };
const SENTIMENTS = ["怒り", "不満", "不安", "中立", "期待", "満足"];
const SENT_COLORS = {
  怒り: "#8f2418", 不満: P.vermilion, 不安: P.gold,
  中立: P.neutral, 期待: "#5e8bb0", 満足: P.indigo,
};
const CATEGORIES = ["政府・政権", "政党", "省庁・行政機関", "地方自治体", "団体・組織", "企業", "政策・制度", "社会全般"];
const CAT_COLORS = ["#1e4266", "#2b5d8c", "#5e8bb0", "#3f7d5c", "#b9862c", "#a05a2c", "#c23a2b", "#8a94a0"];
const CHUNK_TYPES = ["提言", "不満", "要望", "評価", "懸念"];
const TYPE_COLORS = { 提言: P.indigo, 不満: P.vermilion, 要望: P.gold, 評価: P.green, 懸念: "#7a5aa0" };
const PARAM_DEFS = [
  { key: "validity", label: "妥当性", desc: "根拠の明確さ・論理性" },
  { key: "criticality", label: "クリティカル度", desc: "批判の強度・緊急性" },
  { key: "motivation", label: "意欲", desc: "政治参加への意欲" },
  { key: "constructiveness", label: "建設性", desc: "代替案・改善志向" },
  { key: "specificity", label: "具体性", desc: "対象・内容の具体度" },
];

/* ---------- 既定の設問セット(設問管理画面で変更可能) ---------- */
const KEY_Q = "q_support";
const DEFAULT_CONFIG = {
  version: 1,
  demographics: [
    { id: "age", label: "年代", options: ["10代", "20代", "30代", "40代", "50代", "60代", "70代以上"], required: true },
    { id: "gender", label: "性別", options: ["男性", "女性", "その他", "回答しない"], required: false },
    { id: "occupation", label: "職業", options: ["会社員", "公務員", "自営業", "学生", "主婦・主夫", "無職", "その他"], required: false },
    { id: "region", label: "居住地域", options: ["北海道", "東北", "関東", "中部", "近畿", "中国", "四国", "九州・沖縄"], required: false },
  ],
  questions: [
    { id: KEY_Q, label: "現在の政権を支持しますか", type: "choice", key: true,
      options: ["支持する", "どちらかといえば支持", "どちらともいえない", "どちらかといえば不支持", "支持しない"] },
    { id: "q_interest", label: "関心のある政策分野(複数選択可)", type: "multi",
      options: ["経済・財政", "社会保障", "外交・安全保障", "教育", "環境・エネルギー", "地方創生", "子育て支援", "行政改革"] },
    { id: "q_vote", label: "次の選挙で投票に行く予定はありますか", type: "choice",
      options: ["必ず行く", "たぶん行く", "わからない", "行かない"] },
  ],
  freeText: {
    id: "free_opinion",
    label: "政治・社会に対するご意見(自由記述)",
    placeholder: "政策への提言、不満、要望、評価など、対象を挙げて自由にお書きください。例:「◯◯省の△△という制度について、…と考えている」",
  },
};

/* ---------- 永続ストレージ (window.storage / 無い環境ではメモリ) ---------- */
const K = { config: "seiseki:config", resp: "seiseki:responses", clusters: "seiseki:clusters" };
const memStore = {};
const hasStorage = () => typeof window !== "undefined" && !!window.storage;
const store = {
  async get(key) {
    try {
      if (!hasStorage()) return memStore[key] ?? null;
      const r = await window.storage.get(key);
      return r && r.value != null ? JSON.parse(r.value) : null;
    } catch (e) { return null; }
  },
  async set(key, val) {
    try {
      if (!hasStorage()) { memStore[key] = val; return true; }
      const r = await window.storage.set(key, JSON.stringify(val));
      return !!r;
    } catch (e) { console.error("storage set error", e); return false; }
  },
  async del(key) {
    try {
      if (!hasStorage()) { delete memStore[key]; return true; }
      await window.storage.delete(key);
      return true;
    } catch (e) { return false; }
  },
};

/* ---------- ユーティリティ ---------- */
const uid = () => "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
const clamp = (v, lo, hi) => {
  const n = Number(v);
  if (Number.isNaN(n)) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, n));
};
const groupOf = (v) => {
  const s = String(v || "");
  if (!s) return "未回答";
  if (s.includes("不支持")) return "不支持";
  if (s.includes("支持")) return "支持";
  return "中立";
};
const fmtDate = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const counter = (arr) => {
  const m = new Map();
  arr.forEach((x) => { if (x) m.set(x, (m.get(x) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/* ---------- 分析結果の正規化(欠損・異常値の防御) ---------- */
function normalizeAnalysis(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const p = a.params || {};
  const sn = a.sentiment || {};
  const id = a.ideology || {};
  return {
    sentiment: {
      label: SENTIMENTS.includes(sn.label) ? sn.label : "中立",
      score: Number(clamp(sn.score, -1, 1).toFixed(2)),
    },
    params: {
      validity: Math.round(clamp(p.validity, 0, 100)),
      criticality: Math.round(clamp(p.criticality, 0, 100)),
      motivation: Math.round(clamp(p.motivation, 0, 100)),
      constructiveness: Math.round(clamp(p.constructiveness, 0, 100)),
      specificity: Math.round(clamp(p.specificity, 0, 100)),
    },
    ideology: {
      economic: Number(clamp(id.economic, -1, 1).toFixed(2)),
      social: Number(clamp(id.social, -1, 1).toFixed(2)),
    },
    topics: Array.isArray(a.topics) ? a.topics.slice(0, 6).map(String) : [],
    chunks: (Array.isArray(a.chunks) ? a.chunks : []).slice(0, 8).map((c) => ({
      text: String(c.text || "").slice(0, 100),
      type: CHUNK_TYPES.includes(c.type) ? c.type : "評価",
      summary: String(c.summary || c.text || "").slice(0, 140),
      target_category: CATEGORIES.includes(c.target_category) ? c.target_category : "社会全般",
      target: String(c.target || "不特定").slice(0, 40),
      stance: ["肯定", "否定", "中立"].includes(c.stance) ? c.stance : "中立",
      keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 5).map(String) : [],
      intensity: Math.round(clamp(c.intensity, 0, 100)),
    })),
    verify_flags: (Array.isArray(a.verify_flags) ? a.verify_flags : []).slice(0, 5).map((f) => ({
      claim: String(f.claim || "").slice(0, 120),
      reason: String(f.reason || "").slice(0, 120),
    })),
  };
}

/* ---------- AI分析(Anthropic API) ---------- */
function buildAnalysisPrompt(demographics, answers, freeText, config) {
  const demoLines = config.demographics
    .map((d) => `${d.label}: ${demographics[d.id] || "未回答"}`).join("\n");
  const qLines = config.questions.map((q) => {
    const a = answers[q.id];
    const v = Array.isArray(a) ? (a.length ? a.join("、") : "未回答") : (a || "未回答");
    return `Q. ${q.label}\nA. ${v}`;
  }).join("\n");
  return `あなたは世論調査回答を定量分析する専門AIです。以下の回答を分析し、指定スキーマのJSONのみを出力してください。前置き・説明・マークダウン記法は一切禁止です。

【回答者属性】
${demoLines}

【選択式回答】
${qLines}

【自由記述】
"${(freeText || "").slice(0, 1200)}"

【出力スキーマ】
{
 "sentiment": {"label": "怒り/不満/不安/中立/期待/満足 のいずれか", "score": -1.0から1.0},
 "params": {"validity": 0-100の整数(根拠の明確さ・論理性), "criticality": 0-100(批判の強度・緊急性), "motivation": 0-100(政治参加意欲), "constructiveness": 0-100(建設性), "specificity": 0-100(具体性)},
 "ideology": {"economic": -1.0から1.0(-1=再分配重視,+1=市場重視), "social": -1.0から1.0(-1=リベラル,+1=保守)},
 "topics": ["主要トピック名を最大5件"],
 "chunks": [{"text": "該当箇所の30字以内要約", "type": "提言/不満/要望/評価/懸念", "summary": "一文要約", "target_category": "政府・政権/政党/省庁・行政機関/地方自治体/団体・組織/企業/政策・制度/社会全般", "target": "対象の固有名または一般名", "stance": "肯定/否定/中立", "keywords": ["語を最大3件"], "intensity": 0-100}],
 "verify_flags": [{"claim": "事実確認が必要な記述", "reason": "理由"}]
}

【制約】
- chunksは意見の意味単位で区切り、重要な順に最大5件。
- 不満は「(対象)に対して(内容)と思っている」構造でtarget/summaryに反映する。
- verify_flagsは真偽の断定ではなく「要検証」の指摘に留める。該当なしなら空配列。
- 自由記述が空の場合、chunksとverify_flagsは空配列とし、paramsは選択式回答から推定する。
- JSON以外の文字を出力しない。`;
}

async function analyzeWithAI(demographics, answers, freeText, config) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: buildAnalysisPrompt(demographics, answers, freeText, config) }],
    }),
  });
  if (!res.ok) throw new Error("API error: " + res.status);
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const cleaned = text.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("JSONが見つかりません");
  return JSON.parse(cleaned.slice(s, e + 1));
}

/* ---------- 簡易分析(オフライン・フォールバック) ---------- */
function fallbackAnalyze(demographics, answers, freeText, config) {
  const t = String(freeText || "");
  const g = groupOf(answers[KEY_Q]);
  let score = g === "不支持" ? -0.4 : g === "支持" ? 0.3 : 0;
  ["不満", "怒", "反対", "最悪", "失望", "許せ", "不安", "心配", "批判", "ひどい", "苦し"].forEach((w) => { if (t.includes(w)) score -= 0.12; });
  ["期待", "賛成", "良い", "評価", "希望", "応援", "助か", "ありがた"].forEach((w) => { if (t.includes(w)) score += 0.12; });
  score = clamp(score, -1, 1);
  const label = score <= -0.55 ? "怒り" : score <= -0.2 ? "不満" : score < 0 ? "不安" : score < 0.2 ? "中立" : score < 0.5 ? "期待" : "満足";
  const vote = String(answers.q_vote || "");
  const motivation = vote.includes("必ず") ? 85 : vote.includes("たぶん") ? 60 : vote.includes("わからない") ? 40 : vote.includes("行かない") ? 20 : 50;
  const catRules = [
    ["政府・政権", ["政権", "政府", "内閣", "首相", "総理"]],
    ["政党", ["党", "議員", "国会"]],
    ["省庁・行政機関", ["省", "庁", "行政", "役所", "マイナンバー"]],
    ["地方自治体", ["市", "県", "区", "町", "村", "自治体", "知事"]],
    ["企業", ["会社", "企業", "電力"]],
    ["団体・組織", ["団体", "組合", "協会"]],
    ["政策・制度", ["税", "年金", "保険", "教育", "医療", "制度", "政策", "予算", "支援"]],
  ];
  let cat = "社会全般"; let target = "不特定";
  for (const [c, words] of catRules) {
    const hit = words.find((w) => t.includes(w));
    if (hit) { cat = c; target = hit; break; }
  }
  const type = score < -0.2 ? "不満" : (t.includes("べき") || t.includes("ほしい") || t.includes("欲しい")) ? "要望" : score > 0.2 ? "評価" : "懸念";
  const chunks = t.trim() ? [{
    text: t.slice(0, 30), type, summary: t.slice(0, 60),
    target_category: cat, target, stance: score < -0.1 ? "否定" : score > 0.1 ? "肯定" : "中立",
    keywords: [], intensity: Math.round(Math.abs(score) * 100),
  }] : [];
  return normalizeAnalysis({
    sentiment: { label, score },
    params: {
      validity: 50, criticality: Math.round(clamp(50 - score * 50, 0, 100)),
      motivation, constructiveness: 50, specificity: Math.round(clamp(t.length / 3, 10, 90)),
    },
    ideology: { economic: 0, social: 0 },
    topics: [], chunks, verify_flags: [],
  });
}

/* ---------- サンプルデータ(動作確認用・架空の回答) ---------- */
function sampleRecords() {
  const ck = (text, type, summary, cat, target, stance, keywords, intensity) =>
    ({ text, type, summary, target_category: cat, target, stance, keywords, intensity });
  const rows = [
    {
      d: { age: "40代", gender: "男性", occupation: "会社員", region: "関東" },
      a: { [KEY_Q]: "支持しない", q_interest: ["経済・財政", "子育て支援"], q_vote: "必ず行く" },
      t: "物価高への対策が不十分だと感じる。消費税の一時的な引き下げを検討してほしい。児童手当は助かっているが、申請手続きが煩雑すぎる。",
      an: { sentiment: { label: "不満", score: -0.55 },
        params: { validity: 72, criticality: 68, motivation: 85, constructiveness: 70, specificity: 75 },
        ideology: { economic: -0.4, social: -0.1 }, topics: ["物価対策", "税制", "子育て支援"],
        chunks: [
          ck("消費税の一時引き下げの検討を", "提言", "物価高対策として消費税の一時引き下げを提案", "政策・制度", "消費税制度", "否定", ["消費税", "物価高"], 70),
          ck("児童手当の申請手続きが煩雑", "不満", "児童手当の申請手続きの煩雑さに不満", "省庁・行政機関", "行政手続き", "否定", ["児童手当", "手続き"], 60),
        ], verify_flags: [] },
    },
    {
      d: { age: "20代", gender: "女性", occupation: "学生", region: "関東" },
      a: { [KEY_Q]: "どちらともいえない", q_interest: ["教育", "環境・エネルギー"], q_vote: "たぶん行く" },
      t: "奨学金の返済負担が重い。給付型奨学金をもっと増やすべきだと思う。気候変動対策はもっと積極的に進めてほしい。",
      an: { sentiment: { label: "不安", score: -0.25 },
        params: { validity: 65, criticality: 55, motivation: 60, constructiveness: 75, specificity: 65 },
        ideology: { economic: -0.5, social: -0.6 }, topics: ["奨学金", "教育費", "気候変動"],
        chunks: [
          ck("給付型奨学金の拡充を", "提言", "返済負担の軽減へ給付型奨学金の拡充を提案", "政策・制度", "奨学金制度", "否定", ["奨学金", "教育費"], 65),
          ck("気候変動対策の強化を要望", "要望", "気候変動対策のさらなる推進を要望", "政策・制度", "環境政策", "中立", ["気候変動"], 55),
        ], verify_flags: [] },
    },
    {
      d: { age: "60代", gender: "男性", occupation: "自営業", region: "近畿" },
      a: { [KEY_Q]: "支持する", q_interest: ["経済・財政", "地方創生"], q_vote: "必ず行く" },
      t: "現政権の観光振興策は地方経済に貢献していると思う。ただし人手不足への対応は急務。外国人観光客のマナー問題も気になっている。",
      an: { sentiment: { label: "期待", score: 0.35 },
        params: { validity: 70, criticality: 40, motivation: 75, constructiveness: 72, specificity: 70 },
        ideology: { economic: 0.4, social: 0.4 }, topics: ["観光", "地方経済", "人手不足"],
        chunks: [
          ck("観光振興策を評価", "評価", "観光振興策の地方経済への貢献を評価", "政府・政権", "現政権", "肯定", ["観光", "地方経済"], 40),
          ck("人手不足対応は急務", "懸念", "観光業などの人手不足への対応を懸念", "政策・制度", "労働政策", "中立", ["人手不足"], 55),
          ck("観光客のマナー問題", "不満", "外国人観光客のマナー問題への不満", "社会全般", "観光マナー", "否定", ["マナー"], 45),
        ], verify_flags: [] },
    },
    {
      d: { age: "30代", gender: "女性", occupation: "会社員", region: "中部" },
      a: { [KEY_Q]: "どちらかといえば不支持", q_interest: ["社会保障", "子育て支援"], q_vote: "たぶん行く" },
      t: "保育園の待機児童は減ったが、保育士の待遇改善が進んでいない。年金制度が将来もつのか不安。厚生労働省はもっと情報公開をしてほしい。",
      an: { sentiment: { label: "不安", score: -0.35 },
        params: { validity: 68, criticality: 60, motivation: 65, constructiveness: 68, specificity: 72 },
        ideology: { economic: -0.45, social: -0.3 }, topics: ["保育", "年金", "情報公開"],
        chunks: [
          ck("保育士の待遇改善が停滞", "不満", "保育士の待遇改善が進まないことへの不満", "政策・制度", "保育政策", "否定", ["保育士", "待遇"], 65),
          ck("年金制度の持続性が不安", "懸念", "年金制度の将来的な持続性への不安", "政策・制度", "年金制度", "否定", ["年金"], 70),
          ck("情報公開の強化を要望", "要望", "厚生労働省に情報公開の強化を要望", "省庁・行政機関", "厚生労働省", "否定", ["情報公開"], 55),
        ], verify_flags: [] },
    },
    {
      d: { age: "50代", gender: "男性", occupation: "公務員", region: "九州・沖縄" },
      a: { [KEY_Q]: "どちらかといえば支持", q_interest: ["外交・安全保障", "行政改革"], q_vote: "必ず行く" },
      t: "安全保障政策は概ね妥当だと思う。ただ防衛費の使途はより透明にすべき。行政のデジタル化は現場の実情に合っていない部分がある。",
      an: { sentiment: { label: "中立", score: 0.1 },
        params: { validity: 78, criticality: 50, motivation: 70, constructiveness: 80, specificity: 75 },
        ideology: { economic: 0.2, social: 0.5 }, topics: ["安全保障", "防衛費", "行政DX"],
        chunks: [
          ck("安全保障政策は概ね妥当", "評価", "現行の安全保障政策を概ね妥当と評価", "政府・政権", "現政権", "肯定", ["安全保障"], 35),
          ck("防衛費の使途の透明化を", "提言", "防衛費の使途の透明化を提案", "政策・制度", "防衛予算", "中立", ["防衛費", "透明性"], 60),
          ck("行政DXが現場と乖離", "不満", "行政デジタル化が現場実情と乖離しているとの不満", "省庁・行政機関", "行政デジタル化", "否定", ["DX", "現場"], 55),
        ], verify_flags: [] },
    },
    {
      d: { age: "70代以上", gender: "女性", occupation: "無職", region: "東北" },
      a: { [KEY_Q]: "支持しない", q_interest: ["社会保障"], q_vote: "必ず行く" },
      t: "医療費の自己負担が増えて生活が苦しい。高齢者いじめの政策だと感じる。一方で、地元の市役所の窓口対応は丁寧で助かっている。",
      an: { sentiment: { label: "怒り", score: -0.7 },
        params: { validity: 55, criticality: 80, motivation: 70, constructiveness: 40, specificity: 60 },
        ideology: { economic: -0.6, social: 0.2 }, topics: ["医療費", "高齢者福祉"],
        chunks: [
          ck("医療費の自己負担増に反発", "不満", "医療費自己負担の増加で生活が苦しいとの不満", "政策・制度", "医療保険制度", "否定", ["医療費", "自己負担"], 85),
          ck("市役所の窓口対応を評価", "評価", "地元市役所の丁寧な窓口対応を評価", "地方自治体", "地元市役所", "肯定", ["窓口対応"], 30),
        ],
        verify_flags: [{ claim: "高齢者いじめの政策だ", reason: "政策意図に関する主観的評価であり根拠の確認が必要" }] },
    },
    {
      d: { age: "30代", gender: "男性", occupation: "会社員", region: "北海道" },
      a: { [KEY_Q]: "どちらともいえない", q_interest: ["経済・財政", "行政改革"], q_vote: "わからない" },
      t: "マイナンバー関連のシステム障害が多すぎる。発注の仕組みから見直すべきだ。減税より社会保険料の引き下げの方が現役世代には効果的だと思う。",
      an: { sentiment: { label: "不満", score: -0.4 },
        params: { validity: 75, criticality: 65, motivation: 55, constructiveness: 78, specificity: 80 },
        ideology: { economic: 0.1, social: -0.2 }, topics: ["マイナンバー", "行政システム", "社会保険料"],
        chunks: [
          ck("マイナンバー障害が多発", "不満", "マイナンバー関連システム障害の多発への不満", "省庁・行政機関", "デジタル行政", "否定", ["マイナンバー", "障害"], 70),
          ck("システム発注の見直しを", "提言", "行政システムの発注の仕組みの見直しを提案", "省庁・行政機関", "行政調達", "否定", ["発注", "調達"], 65),
          ck("社会保険料の引き下げを", "提言", "減税より社会保険料引き下げが効果的と提案", "政策・制度", "社会保険料", "中立", ["社会保険料"], 60),
        ],
        verify_flags: [{ claim: "システム障害が多すぎる", reason: "発生頻度の定量的根拠が示されていない" }] },
    },
    {
      d: { age: "20代", gender: "男性", occupation: "会社員", region: "中国" },
      a: { [KEY_Q]: "支持しない", q_interest: ["経済・財政"], q_vote: "行かない" },
      t: "給料が上がらないのに税金と保険料ばかり増える。政治家は自分たちの報酬を先に見直すべきだ。投票しても何も変わらない気がする。",
      an: { sentiment: { label: "怒り", score: -0.75 },
        params: { validity: 50, criticality: 85, motivation: 25, constructiveness: 35, specificity: 55 },
        ideology: { economic: -0.2, social: -0.3 }, topics: ["手取り", "議員報酬", "政治不信"],
        chunks: [
          ck("負担増と賃金停滞への怒り", "不満", "賃金が上がらない中での税・保険料負担増に強い不満", "政策・制度", "税・社会保険料", "否定", ["税金", "保険料"], 80),
          ck("議員報酬の見直しを要求", "要望", "政治家報酬の見直しを先に行うべきとの要求", "政党", "国会議員", "否定", ["議員報酬"], 75),
          ck("政治への無力感", "懸念", "投票しても変わらないという政治への無力感", "社会全般", "政治参加", "否定", ["政治不信"], 65),
        ], verify_flags: [] },
    },
    {
      d: { age: "50代", gender: "女性", occupation: "主婦・主夫", region: "四国" },
      a: { [KEY_Q]: "どちらかといえば支持", q_interest: ["子育て支援", "教育"], q_vote: "たぶん行く" },
      t: "給食費の無償化はありがたい。一方で教員不足が深刻なので、学校現場にもっとお金と人を回してほしい。",
      an: { sentiment: { label: "期待", score: 0.3 },
        params: { validity: 66, criticality: 45, motivation: 60, constructiveness: 75, specificity: 65 },
        ideology: { economic: -0.35, social: 0.1 }, topics: ["給食無償化", "教員不足"],
        chunks: [
          ck("給食費無償化を評価", "評価", "給食費無償化の施策を評価", "政策・制度", "教育支援", "肯定", ["給食費"], 30),
          ck("学校現場へ予算と人員を", "要望", "教員不足解消へ学校現場への予算・人員配分を要望", "政策・制度", "教育予算", "中立", ["教員不足"], 60),
        ], verify_flags: [] },
    },
    {
      d: { age: "40代", gender: "女性", occupation: "自営業", region: "近畿" },
      a: { [KEY_Q]: "どちらともいえない", q_interest: ["経済・財政", "環境・エネルギー"], q_vote: "必ず行く" },
      t: "電気代の高騰が経営を圧迫している。大手電力会社の料金体系は不透明だと感じる。再エネ賦課金についての説明も不十分ではないか。",
      an: { sentiment: { label: "不満", score: -0.45 },
        params: { validity: 70, criticality: 62, motivation: 72, constructiveness: 60, specificity: 78 },
        ideology: { economic: 0.0, social: -0.1 }, topics: ["電気代", "エネルギー政策"],
        chunks: [
          ck("電気代高騰が経営を圧迫", "不満", "電気代の高騰による経営圧迫への不満", "企業", "大手電力会社", "否定", ["電気代"], 75),
          ck("料金体系が不透明", "不満", "電力料金体系の不透明さへの不満", "企業", "大手電力会社", "否定", ["料金体系"], 65),
          ck("再エネ賦課金の説明を", "要望", "再エネ賦課金に関する説明責任を要望", "政策・制度", "エネルギー政策", "否定", ["再エネ賦課金"], 55),
        ], verify_flags: [] },
    },
  ];
  const now = Date.now();
  return rows.map((r, i) => ({
    id: "smp_" + now.toString(36) + "_" + i,
    ts: now - (i + 1) * 43200000,
    demographics: r.d,
    answers: r.a,
    freeText: r.t,
    analysis: normalizeAnalysis(r.an),
    engine: "サンプル",
    consent: { ts: now - (i + 1) * 43200000 },
  }));
}

/* ============================================================
   UI 基本部品
   ============================================================ */
function Eyebrow({ children }) {
  return (
    <div style={{ fontFamily: SERIF, fontSize: 13, letterSpacing: 3, color: P.indigoDeep, marginBottom: 6 }}>
      【{children}】
    </div>
  );
}
function Card({ children, style }) {
  return (
    <div style={{ background: P.paper, border: `1px solid ${P.line}`, borderRadius: 10, padding: 18, ...style }}>
      {children}
    </div>
  );
}
function Btn({ children, onClick, kind = "primary", disabled, small, style }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "center",
    padding: small ? "6px 12px" : "10px 18px", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
    fontSize: small ? 12.5 : 14, fontWeight: 600, fontFamily: SANS, border: "1px solid transparent",
    opacity: disabled ? 0.45 : 1, transition: "opacity .15s", ...style,
  };
  const kinds = {
    primary: { background: P.indigo, color: "#fff" },
    danger: { background: P.vermilion, color: "#fff" },
    ghost: { background: "transparent", color: P.indigo, border: `1px solid ${P.line}` },
    subtle: { background: P.indigoSoft, color: P.indigoDeep },
  };
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled} style={{ ...base, ...kinds[kind] }}>
      {children}
    </button>
  );
}
function Chip({ active, onClick, children, color }) {
  return (
    <button onClick={onClick} style={{
      padding: "7px 13px", borderRadius: 999, fontSize: 13, cursor: "pointer", fontFamily: SANS,
      border: `1.5px solid ${active ? (color || P.indigo) : P.line}`,
      background: active ? (color || P.indigo) : P.paper,
      color: active ? "#fff" : P.sub, fontWeight: active ? 600 : 400,
    }}>{children}</button>
  );
}
function Pill({ children, color, soft }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 600,
      background: soft ? `${color}18` : color, color: soft ? color : "#fff",
      border: soft ? `1px solid ${color}55` : "none",
    }}>{children}</span>
  );
}
function Meter({ label, value, color, tick, tickLabel }) {
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: P.sub, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ fontWeight: 700, color: P.ink }}>{value}<span style={{ color: P.faint, fontWeight: 400 }}> /100</span></span>
      </div>
      <div style={{ position: "relative", height: 8, background: P.grid, borderRadius: 4 }}>
        <div style={{ width: `${clamp(value, 0, 100)}%`, height: "100%", background: color || P.indigo, borderRadius: 4 }} />
        {tick != null && (
          <div title={tickLabel} style={{ position: "absolute", left: `calc(${clamp(tick, 0, 100)}% - 1px)`, top: -3, width: 2, height: 14, background: P.ink, opacity: 0.5 }} />
        )}
      </div>
    </div>
  );
}
function Stamp({ text, size = 76 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      border: `2.5px solid ${P.vermilion}`, color: P.vermilion,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: SERIF, fontWeight: 700, fontSize: size / 5.2, transform: "rotate(-8deg)",
      letterSpacing: 2, textAlign: "center", lineHeight: 1.3, padding: 6,
      boxShadow: "inset 0 0 0 1.5px rgba(194,58,43,0.28)",
    }}>{text}</div>
  );
}
function ChipSelect({ options, value, onChange, multi }) {
  const isOn = (o) => (multi ? (value || []).includes(o) : value === o);
  const toggle = (o) => {
    if (multi) {
      const cur = value || [];
      onChange(cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]);
    } else onChange(value === o ? "" : o);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {options.map((o) => <Chip key={o} active={isOn(o)} onClick={() => toggle(o)}>{o}</Chip>)}
    </div>
  );
}
function Notice({ icon, color, children }) {
  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, lineHeight: 1.7,
      background: `${color}12`, border: `1px solid ${color}44`, color: P.ink,
      borderRadius: 8, padding: "10px 12px",
    }}>
      <span style={{ color, flexShrink: 0, marginTop: 2 }}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

/* ============================================================
   同意画面(プライバシーポリシー・宣誓)
   ============================================================ */
const POLICY = [
  { h: "1. 本調査の目的", b: "本システム「声析」は、政治・社会に関する意見を収集し、AIにより多次元パラメータへ定量化して統計的に分析・可視化することを目的とします。回答は統計処理された形でのみ利用します。" },
  { h: "2. 収集する情報", b: "年代・性別・職業・居住地域などの社会的属性、選択式設問への回答、および自由記述の意見を収集します。氏名・住所・電話番号・メールアドレス等、個人を直接特定できる情報は収集しません。自由記述に個人を特定できる情報を記載しないでください。" },
  { h: "3. AIによる分析処理", b: "回答内容は、感情・妥当性・クリティカル度・意欲などのパラメータ算出および意見の抽出・分類のため、外部のAI分析サービス(Anthropic API)へ送信され処理されます。分析結果は匿名の統計データとして保存されます。" },
  { h: "4. 保存と管理", b: "回答は匿名IDに紐づけて保存され、回答者個人と結びつく形では管理しません。データは本システムの統計・研究目的にのみ利用します。" },
  { h: "5. 公表の方法", b: "分析結果は、個人が特定できない集計・統計データ(グラフ、意見グループ等)としてのみ表示・公表します。" },
  { h: "6. 第三者提供", b: "法令に基づく場合を除き、収集したデータを第三者へ提供しません。広告目的での利用は行いません。" },
  { h: "7. 削除の権利", b: "回答データは、データ管理画面からいつでも個別または全件を削除できます。" },
  { h: "8. 対象", b: "本調査は18歳以上の方を対象とします。" },
  { h: "9. 留意事項", b: "AIによる分析値は統計的推定であり、回答者の内心や事実の真偽を断定するものではありません。「要検証」の指摘は真偽判定ではなく、確認を促す参考情報です。" },
];
function ConsentView({ onAgree, onBack }) {
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(false);
  const Check = ({ on, set, children }) => (
    <button onClick={() => set(!on)} style={{
      display: "flex", gap: 10, alignItems: "flex-start", width: "100%", textAlign: "left",
      background: on ? P.indigoSoft : P.paper, border: `1.5px solid ${on ? P.indigo : P.line}`,
      borderRadius: 8, padding: "11px 13px", cursor: "pointer", fontSize: 13.5, color: P.ink, lineHeight: 1.6,
    }}>
      <CheckCircle2 size={19} style={{ color: on ? P.indigo : P.faint, flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
          <Stamp text={"同意\n確認"} size={64} />
          <div>
            <Eyebrow>個人情報の取り扱いについて</Eyebrow>
            <h2 style={{ fontFamily: SERIF, fontSize: 20, margin: 0, color: P.ink }}>調査への同意</h2>
            <p style={{ fontSize: 12.5, color: P.sub, margin: "4px 0 0" }}>回答の前に、以下の方針を必ずお読みください。</p>
          </div>
        </div>
        <div style={{
          maxHeight: 300, overflowY: "auto", border: `1px solid ${P.line}`, borderRadius: 8,
          padding: "14px 16px", background: "#fcfdfe",
        }}>
          {POLICY.map((s) => (
            <div key={s.h} style={{ marginBottom: 13 }}>
              <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 13.5, color: P.indigoDeep, marginBottom: 3 }}>{s.h}</div>
              <div style={{ fontSize: 12.5, color: P.sub, lineHeight: 1.8 }}>{s.b}</div>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: P.faint, borderTop: `1px dashed ${P.line}`, paddingTop: 10 }}>
            ※ 本文書はプロトタイプ用の雛形です。実運用の際は個人情報保護法等に基づく法務確認を行ってください。
          </div>
        </div>
      </Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Check on={c1} set={setC1}>上記のプライバシーポリシーおよび利用条件を読み、内容に同意します。また、私は18歳以上です。</Check>
        <Check on={c2} set={setC2}>回答内容が匿名の形で外部AIサービスに送信され、定量分析・統計化されることに同意します。</Check>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Btn kind="ghost" onClick={onBack}><X size={15} />戻る</Btn>
        <Btn onClick={onAgree} disabled={!(c1 && c2)} style={{ flex: 1 }}>
          <ShieldCheck size={16} />同意して回答へ進む
        </Btn>
      </div>
    </div>
  );
}

/* ============================================================
   アンケート回答画面
   ============================================================ */
function SurveyView({ config, onSubmit, busy }) {
  const [demo, setDemo] = useState({});
  const [answers, setAnswers] = useState({});
  const [freeText, setFreeText] = useState("");
  const [err, setErr] = useState("");
  const submit = () => {
    for (const d of config.demographics) {
      if (d.required && !demo[d.id]) { setErr(`「${d.label}」は必須項目です。`); return; }
    }
    if (!answers[KEY_Q]) { setErr("主要設問(政権支持)への回答は必須です。"); return; }
    setErr("");
    onSubmit(demo, answers, freeText.trim());
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <Eyebrow>第一部・回答者属性</Eyebrow>
        <p style={{ fontSize: 12.5, color: P.sub, margin: "0 0 14px" }}>統計の切り口として利用します(個人は特定されません)。</p>
        {config.demographics.map((d) => (
          <div key={d.id} style={{ marginBottom: 15 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: P.ink, marginBottom: 7 }}>
              {d.label}{d.required && <span style={{ color: P.vermilion, marginLeft: 5, fontSize: 11 }}>※必須</span>}
            </div>
            <ChipSelect options={d.options} value={demo[d.id]} onChange={(v) => setDemo({ ...demo, [d.id]: v })} />
          </div>
        ))}
      </Card>
      <Card>
        <Eyebrow>第二部・設問</Eyebrow>
        {config.questions.map((q) => (
          <div key={q.id} style={{ marginBottom: 17 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: P.ink, marginBottom: 7, lineHeight: 1.6 }}>
              {q.label}
              {q.key && <Pill color={P.vermilion} soft>主要設問</Pill>}
            </div>
            <ChipSelect
              options={q.options}
              multi={q.type === "multi"}
              value={answers[q.id]}
              onChange={(v) => setAnswers({ ...answers, [q.id]: v })}
            />
          </div>
        ))}
      </Card>
      <Card>
        <Eyebrow>第三部・自由記述</Eyebrow>
        <div style={{ fontSize: 14, fontWeight: 600, color: P.ink, marginBottom: 7 }}>{config.freeText.label}</div>
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder={config.freeText.placeholder}
          rows={6}
          style={{
            width: "100%", boxSizing: "border-box", border: `1.5px solid ${P.line}`, borderRadius: 8,
            padding: 12, fontSize: 14, fontFamily: SANS, color: P.ink, lineHeight: 1.8,
            background: "#fcfdfe", resize: "vertical", outline: "none",
          }}
        />
        <div style={{ fontSize: 11.5, color: P.faint, marginTop: 6 }}>
          ※ 氏名や連絡先など、個人を特定できる情報は記入しないでください。AIが意見を抽出・分類し、統計データとして蓄積します。
        </div>
      </Card>
      {err && <Notice icon={<AlertTriangle size={15} />} color={P.vermilion}>{err}</Notice>}
      <Btn onClick={submit} disabled={busy} style={{ padding: "13px 18px", fontSize: 15 }}>
        <Send size={16} />回答を送信してAI分析にかける
      </Btn>
    </div>
  );
}

/* ============================================================
   分析中画面
   ============================================================ */
function AnalyzingView() {
  const steps = ["回答を受理しました", "自由記述を意見チャンクへ分割中", "感情・妥当性・意欲などを算出中", "対象(政党・省庁・自治体等)を分類中", "データベースへ蓄積中"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(x + 1, steps.length - 1)), 1300);
    return () => clearInterval(t);
  }, []);
  return (
    <Card style={{ textAlign: "center", padding: "44px 20px" }}>
      <Loader2 size={36} style={{ color: P.indigo, animation: "spin 1s linear infinite" }} />
      <style>{"@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}"}</style>
      <div style={{ fontFamily: SERIF, fontSize: 18, color: P.ink, marginTop: 14 }}>AI定量分析を実行中</div>
      <div style={{ fontSize: 13, color: P.sub, marginTop: 8 }}>{steps[i]}…</div>
    </Card>
  );
}

/* ============================================================
   分析結果画面(個票)
   ============================================================ */
function IdeologyPlot({ economic, social, size = 170 }) {
  const x = ((economic + 1) / 2) * 100;
  const y = ((1 - (social + 1) / 2)) * 100;
  return (
    <div style={{ width: size, margin: "0 auto" }}>
      <div style={{
        position: "relative", width: size, height: size, background: "#fcfdfe",
        border: `1px solid ${P.line}`, borderRadius: 8,
      }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: P.grid }} />
        <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: P.grid }} />
        <div style={{
          position: "absolute", left: `${x}%`, top: `${y}%`, width: 12, height: 12,
          borderRadius: "50%", background: P.vermilion, transform: "translate(-50%,-50%)",
          boxShadow: "0 0 0 4px rgba(194,58,43,0.18)",
        }} />
        <span style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: P.faint }}>保守</span>
        <span style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: P.faint }}>リベラル</span>
        <span style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: P.faint }}>再分配</span>
        <span style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: P.faint }}>市場</span>
      </div>
      <div style={{ fontSize: 11, color: P.faint, textAlign: "center", marginTop: 5 }}>
        経済 {economic > 0 ? "+" : ""}{economic} / 社会 {social > 0 ? "+" : ""}{social}
      </div>
    </div>
  );
}
function ChunkCard({ c }) {
  return (
    <div style={{ border: `1px solid ${P.line}`, borderLeft: `4px solid ${TYPE_COLORS[c.type] || P.neutral}`, borderRadius: 8, padding: "10px 12px", background: "#fcfdfe" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 5 }}>
        <Pill color={TYPE_COLORS[c.type] || P.neutral}>{c.type}</Pill>
        <Pill color={P.indigoDeep} soft>{c.target_category}</Pill>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: P.ink }}>{c.target}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: P.faint }}>強度 {c.intensity}</span>
      </div>
      <div style={{ fontSize: 13, color: P.ink, lineHeight: 1.7 }}>{c.summary}</div>
      {c.keywords.length > 0 && (
        <div style={{ fontSize: 11, color: P.faint, marginTop: 4 }}>keywords: {c.keywords.join(" / ")}</div>
      )}
    </div>
  );
}
function ResultView({ record, groupAvgs, onGoStats, onAgain }) {
  const a = record.analysis;
  const g = groupOf(record.answers[KEY_Q]);
  const ga = groupAvgs[g];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <Stamp text={"分析\n完了"} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <Eyebrow>個票分析結果</Eyebrow>
            <h2 style={{ fontFamily: SERIF, fontSize: 20, margin: 0, color: P.ink }}>回答を定量化しました</h2>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
              <Pill color={GROUP_COLORS[g]}>政権支持: {record.answers[KEY_Q]}</Pill>
              <Pill color={SENT_COLORS[a.sentiment.label]}>{a.sentiment.label} ({a.sentiment.score})</Pill>
              <Pill color={record.engine === "AI" ? P.indigo : P.gold} soft>
                {record.engine === "AI" ? "AI分析" : record.engine === "簡易" ? "簡易分析(オフライン)" : record.engine}
              </Pill>
            </div>
          </div>
        </div>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 14 }}>
        <Card>
          <Eyebrow>パラメータ</Eyebrow>
          <p style={{ fontSize: 11.5, color: P.faint, margin: "0 0 12px" }}>
            縦線は「{g}」グループの平均値。あなたの回答は同グループの統計へ反映されました。
          </p>
          {PARAM_DEFS.map((pd) => (
            <Meter key={pd.key} label={`${pd.label}(${pd.desc})`} value={a.params[pd.key]}
              color={GROUP_COLORS[g]} tick={ga ? ga[pd.key] : null} tickLabel={`${g}平均`} />
          ))}
        </Card>
        <Card>
          <Eyebrow>イデオロギー推定</Eyebrow>
          <IdeologyPlot economic={a.ideology.economic} social={a.ideology.social} />
          {a.topics.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
              {a.topics.map((t) => <Pill key={t} color={P.indigo} soft>#{t}</Pill>)}
            </div>
          )}
        </Card>
      </div>
      <Card>
        <Eyebrow>抽出された意見チャンク({a.chunks.length}件)</Eyebrow>
        {a.chunks.length === 0
          ? <div style={{ fontSize: 13, color: P.faint }}>自由記述が無いため、意見チャンクは抽出されませんでした。</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{a.chunks.map((c, i) => <ChunkCard key={i} c={c} />)}</div>}
      </Card>
      {a.verify_flags.length > 0 && (
        <Notice icon={<AlertTriangle size={16} />} color={P.gold}>
          <b>要検証フラグ({a.verify_flags.length}件)</b> — 真偽の断定ではなく、根拠確認を推奨する記述です。
          {a.verify_flags.map((f, i) => (
            <div key={i} style={{ marginTop: 5 }}>「{f.claim}」<span style={{ color: P.faint }}> — {f.reason}</span></div>
          ))}
        </Notice>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Btn onClick={onGoStats} style={{ flex: 1, minWidth: 180 }}><BarChart3 size={16} />統計ダッシュボードを見る</Btn>
        <Btn kind="ghost" onClick={onAgain}><RotateCcw size={15} />続けて回答する</Btn>
      </div>
    </div>
  );
}
