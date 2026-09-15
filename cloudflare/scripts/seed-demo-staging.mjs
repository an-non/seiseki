import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_BASE_URL = "https://seiseki-api-staging.tokyo-odh-129.workers.dev";
const BATCH_ID = "demo-2026-08-10-v1";
const baseUrl = String(process.argv[2] ?? EXPECTED_BASE_URL).replace(/\/$/u, "");
const commit = process.argv.includes("--commit");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const recordPath = resolve(scriptDir, "../demo-seed-records", `${BATCH_ID}.json`);

if (baseUrl !== EXPECTED_BASE_URL) {
  throw new Error(`Refusing to seed a non-staging endpoint: ${baseUrl}`);
}
if (!commit) {
  throw new Error("Persistent staging writes require --commit");
}

const demographics = [
  { age: "20代", gender: "女性", region: "北海道", occupation: "学生", party: "支持政党なし" },
  { age: "30代", gender: "男性", region: "東北", occupation: "会社員(正社員)", party: "回答しない" },
  { age: "40代", gender: "回答しない", region: "関東", occupation: "自営業・フリーランス", party: "立憲民主党" },
  { age: "50代", gender: "女性", region: "中部", occupation: "専門職(医療・法務・教育等)", party: "自民党" },
  { age: "60代", gender: "男性", region: "近畿", occupation: "定年退職", party: "支持政党なし" },
  { age: "30代", gender: "その他", region: "中国", occupation: "会社員(契約・派遣)", party: "国民民主党" },
  { age: "40代", gender: "女性", region: "四国", occupation: "公務員・団体職員", party: "公明党" },
  { age: "20代", gender: "男性", region: "九州・沖縄", occupation: "パート・アルバイト", party: "れいわ新選組" },
  { age: "70代以上", gender: "回答しない", region: "関東", occupation: "定年退職", party: "共産党" },
  { age: "50代", gender: "女性", region: "海外", occupation: "経営者・役員", party: "日本維新の会" }
];

const freeTexts = [
  "子育て支援は所得制限を複雑にせず、保育の受け皿と現場職員の待遇改善を同時に進めてほしい。",
  "地方では公共交通が減り、通院や通学が難しい。自治体をまたぐ路線維持に国も継続的に関与してほしい。",
  "物価上昇に賃金が追いついていない。中小企業が賃上げできるよう、価格転嫁と社会保険料負担を見直してほしい。",
  "大学や専門学校の学費負担が重い。給付型奨学金を拡充し、卒業後の所得に応じた支援を整えてほしい。",
  "防災情報が複数の媒体に分散している。高齢者や外国人にも届く共通の避難案内を地域単位で整備してほしい。",
  "医療の地域差を減らすため、オンライン診療だけでなく救急搬送と地域病院の人員確保にも予算を配分してほしい。",
  "再生可能エネルギーを増やす際は、電気料金と送電網への影響を公開し、地域住民との合意形成を丁寧に行ってほしい。",
  "行政手続きのデジタル化は便利だが、窓口を必要とする人もいる。オンラインと対面の両方を維持してほしい。",
  "政治資金の流れが分かりにくい。収支報告を検索できる統一形式で公開し、訂正履歴も残してほしい。",
  "介護職の人手不足が深刻だ。利用者負担だけを増やさず、職員の賃金と研修環境を改善してほしい。",
  "空き家対策は解体だけでなく、改修して若者や子育て世帯へ貸し出す仕組みも地域ごとに支援してほしい。",
  "学校の教員が事務作業に追われている。支援員を増やし、授業準備と児童生徒への対応時間を確保してほしい。",
  "観光振興で住民生活が圧迫されないよう、混雑やごみ処理の費用を地域に還元する制度を検討してほしい。",
  "農業の担い手不足に対し、新規就農者が機械や農地を共同利用できる仕組みを広げてほしい。",
  "最低賃金を上げるだけでなく、地域の小規模事業者が雇用を維持できる移行支援もセットで行ってほしい。",
  "障害のある人が働き続けられるよう、雇用率だけでなく合理的配慮の実施状況も検証してほしい。",
  "住宅価格と家賃が上がっている。公営住宅の更新と、若年層向けの長期的な住宅支援を進めてほしい。",
  "感染症対策では、流行時だけでなく平時から保健所と検査体制の人員を確保してほしい。",
  "ごみ削減の負担を消費者だけに求めず、製造や流通段階で再利用しやすい設計を促す制度が必要だと思う。",
  "外国人労働者を受け入れるなら、日本語教育、相談窓口、労働条件の監督を一体で整備してほしい。",
  "道路や橋の老朽化が心配だ。新設事業と維持補修の優先順位を、根拠とともに公開してほしい。",
  "表現の自由を守りつつ、インターネット上の詐欺広告やなりすましへの迅速な救済制度を整えてほしい。",
  "選挙の情報が候補者ごとに比較しにくい。政策、財源、実績を同じ項目で確認できる公的な仕組みがほしい。",
  "年金制度の将来見通しを世代別に分かりやすく示し、負担と給付の変更理由を継続して説明してほしい。",
  "文化施設への支援は大都市だけに偏らず、地域の図書館や小規模な劇場も維持できる制度にしてほしい。",
  "治安対策では監視を増やすだけでなく、犯罪被害者の相談、補償、再発防止を一体で進めてほしい。",
  "働き方の柔軟化を進める一方で、長時間労働や偽装請負を防ぐ監督体制も強化してほしい。",
  "研究開発支援は短期成果だけで評価せず、基礎研究と若手研究者の安定した雇用にも継続予算を確保してほしい。",
  "地方自治体の財政状況を比較しやすくし、公共事業の費用と効果を住民が追跡できるようにしてほしい。",
  "税制改正は制度を複雑にしすぎず、誰の負担がどの程度変わるのか具体例を示して議論してほしい。"
];

const priorities = ["暮らし", "教育", "医療", "経済", "防災", "環境", "行政", "労働"];
const records = freeTexts.map((freeText, index) => ({
  key: `${BATCH_ID}-${String(index + 1).padStart(2, "0")}`,
  freeText,
  demo: demographics[index % demographics.length],
  answers: {
    q_priority: priorities[index % priorities.length],
    q_support: ["支持する", "どちらかといえば支持する", "わからない", "どちらかといえば支持しない"][index % 4],
    demo_batch: BATCH_ID
  }
}));

async function request(path, options = {}, expected = [200]) {
  const headers = new Headers(options.headers);
  if (options.body != null) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 160) }; }
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${path}: HTTP ${response.status} ${body?.error ?? ""}`.trim());
  }
  return body;
}

async function loadProgress() {
  try {
    const parsed = JSON.parse(await readFile(recordPath, "utf8"));
    return parsed.batchId === BATCH_ID && Array.isArray(parsed.items) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

let progress = await loadProgress() ?? {
  batchId: BATCH_ID,
  endpoint: baseUrl,
  startedAt: new Date().toISOString(),
  completedAt: null,
  items: records.map(record => ({ key: record.key, id: null, analysisStatus: "not-created", chunks: 0 }))
};

async function saveProgress() {
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

async function createAndAnalyze(index) {
  const record = records[index];
  const item = progress.items[index];
  if (item.id && item.analysisStatus === "completed") return;
  if (!item.id) {
    const created = await request("/api/responses", {
      method: "POST",
      body: JSON.stringify({
        appVersion: "staging-demo-1",
        consent: { accepted: true, version: "demo-1", at: Date.now() },
        demo: record.demo,
        answers: record.answers,
        freeText: record.freeText,
        demoFlag: true
      })
    }, [201]);
    item.id = created.id;
    item.analysisStatus = created.analysisStatus ?? "pending";
    await saveProgress();
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const analysis = await request(`/api/responses/${item.id}/analysis`);
    item.analysisStatus = analysis?.analysisStatus ?? "missing";
    item.chunks = Array.isArray(analysis?.analysis?.chunks) ? analysis.analysis.chunks.length : 0;
    item.errorCode = analysis?.errorCode ?? null;
    await saveProgress();
    if (item.analysisStatus !== "pending") return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`${record.key}: analysis remained pending`);
}

await saveProgress();
for (let start = 0; start < records.length; start += 2) {
  await Promise.all([start, start + 1].filter(index => index < records.length).map(createAndAnalyze));
  const completed = progress.items.filter(item => item.analysisStatus === "completed").length;
  console.log(JSON.stringify({ batchId: BATCH_ID, completed, total: records.length }));
}

progress.completedAt = new Date().toISOString();
await saveProgress();
const statuses = Object.fromEntries(progress.items.reduce((map, item) => {
  map.set(item.analysisStatus, (map.get(item.analysisStatus) ?? 0) + 1);
  return map;
}, new Map()));
console.log(JSON.stringify({
  status: statuses.completed === records.length ? "completed" : "incomplete",
  batchId: BATCH_ID,
  records: records.length,
  statuses,
  chunks: progress.items.reduce((sum, item) => sum + item.chunks, 0),
  recordPath
}, null, 2));

if (statuses.completed !== records.length) process.exitCode = 1;
