const QUESTION_TYPES = new Set(["single", "scale", "free"]);

export const DEFAULT_QUESTIONS = Object.freeze([
  Object.freeze({ id: "q_support", type: "single", text: "現在の政権を支持しますか？", options: Object.freeze(["支持する", "どちらかといえば支持する", "どちらかといえば支持しない", "支持しない", "わからない"]) }),
  Object.freeze({ id: "q_priority", type: "single", text: "いま最も重視する政策分野はどれですか？", options: Object.freeze(["経済・雇用", "社会保障・医療", "子育て・教育", "外交・安全保障", "環境・エネルギー", "行政改革・政治とカネ", "その他"]) }),
  Object.freeze({ id: "q_econ", type: "scale", text: "経済政策の方向性について、あなたの考えに近いのはどちらですか？", left: "財政支出を拡大し再分配を強化すべき", right: "財政健全化と市場活力を優先すべき", options: Object.freeze(["1", "2", "3", "4", "5"]) }),
  Object.freeze({ id: "q_information", type: "single", text: "政策や制度について判断するために必要な情報を、十分に得られていると思いますか？", options: Object.freeze(["十分に得られている", "どちらかといえば得られている", "どちらかといえば不足している", "不足している", "わからない"]) }),
  Object.freeze({ id: "q_social", type: "scale", text: "公共政策で価値が衝突するとき、あなたの考えに近いのはどちらですか？", left: "個人の選択と自由を優先すべき", right: "社会全体の安全と秩序を優先すべき", options: Object.freeze(["1", "2", "3", "4", "5"]) }),
  Object.freeze({ id: "q_life", type: "single", text: "現在の制度や政策は、あなたが日常生活で感じる課題に対応していると思いますか？", options: Object.freeze(["対応している", "どちらかといえば対応している", "どちらかといえば対応していない", "対応していない", "わからない"]) }),
  Object.freeze({ id: "q_participation", type: "single", text: "政策の決定過程に、国民の意見が十分に反映されていると思いますか？", options: Object.freeze(["十分に反映されている", "どちらかといえば反映されている", "どちらかといえば反映されていない", "反映されていない", "わからない"]) }),
  Object.freeze({ id: "q_free", type: "free", text: "政治・行政に対する意見・提言・不満があれば自由にお書きください。", placeholder: "例: ◯◯省の△△制度について…、地元の□□に関して…(任意・複数の話題可)" })
]);

function clean(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s{2,}/gu, " ").trim().slice(0, max);
}

export function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return null;
  const output = [];
  const ids = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || output.length >= 100) continue;
    const id = clean(candidate.id, 64);
    const type = clean(candidate.type, 10);
    const text = clean(candidate.text, 200);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id) || ids.has(id) || !QUESTION_TYPES.has(type) || !text) continue;
    const question = { id, type, text };
    if (type === "single" || type === "scale") {
      const options = Array.isArray(candidate.options) ? candidate.options.slice(0, 12).map(option => clean(option, 60)).filter(Boolean) : [];
      if (options.length < 2) continue;
      question.options = options;
    }
    if (type === "scale") {
      question.left = clean(candidate.left, 80);
      question.right = clean(candidate.right, 80);
      if (!question.left || !question.right) continue;
    }
    if (type === "free") question.placeholder = clean(candidate.placeholder, 120);
    ids.add(id);
    output.push(question);
  }
  return output.length ? output : null;
}

export async function loadQuestions(db) {
  const row = await db.prepare("SELECT value_json AS valueJson FROM app_config WHERE key = 'questions'").first();
  if (row?.valueJson) {
    try {
      const stored = sanitizeQuestions(JSON.parse(row.valueJson));
      if (stored) return stored;
    } catch {}
  }
  return DEFAULT_QUESTIONS.map(question => ({ ...question, ...(question.options ? { options: [...question.options] } : {}) }));
}

export function validateAnswersAgainstQuestions(answers, questions, allowDemoMetadata = false) {
  const byId = new Map(questions.filter(question => question.type !== "free").map(question => [question.id, question]));
  return answers.every(answer => {
    if (allowDemoMetadata && answer.qid === "demo_batch") return true;
    const question = byId.get(answer.qid);
    return !!question && question.options.includes(answer.value);
  });
}

export function snapshotQuestions(questions) {
  return questions.filter(question => question.type !== "free").map((question, position) => ({
    qid: question.id,
    position,
    type: question.type,
    text: question.text,
    options: [...question.options],
    left: question.left || "",
    right: question.right || ""
  }));
}
