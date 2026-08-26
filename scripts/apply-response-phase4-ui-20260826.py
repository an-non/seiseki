from pathlib import Path


def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"{label}: marker not found")
    return text.replace(old, new, 1)

path = Path("core/ui.jsx")
text = path.read_text(encoding="utf-8")

# Cloud update adapters.
marker = "\nasync function cloudResponseAuthHeaders(id) {"
if "async function cloudPatchFreeText" not in text:
    addition = r'''
async function cloudPatchFreeText(id, expectedRevision, freeText) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/free-text", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision, freeText: freeText })
  });
}

async function cloudPatchAnswers(id, expectedRevision, answers) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/answers", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision, answers: answers })
  });
}

async function cloudRequeueAnalysis(id, expectedRevision) {
  return cloudApiRequest("/api/responses/" + encodeURIComponent(id) + "/analysis/requeue", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await cloudResponseAuthHeaders(id)) },
    body: JSON.stringify({ expectedRevision: expectedRevision })
  });
}
'''
    if marker not in text:
        raise RuntimeError("cloud helper insertion marker not found")
    text = text.replace(marker, addition + marker, 1)

# Preserve current remote revision when loading own response.
text = replace_once(text,
'''    response.remoteId = id;
    response.analysis = state.analysis;''',
'''    response.remoteId = id;
    response.remoteRevision = Number(raw && raw.revision || response.revision || response.seq || 1);
    response.revision = response.remoteRevision;
    response.analysis = state.analysis;''',
"own response revision")

# Survey state: replace the old 2-response/addendum model with one current response.
text = replace_once(text,
'''  const [restored, setRestored] = useState(false);
  const [addendum, setAddendum] = useState(null); // 2回目(追記)の対象
  const [limit, setLimit] = useState(null);       // 2回とも回答済み
  const busyRef = useRef(false);''',
'''  const [restored, setRestored] = useState(false);
  const [currentResponse, setCurrentResponse] = useState(null);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [editMode, setEditMode] = useState(null); // append | free | answers
  const [editText, setEditText] = useState("");
  const busyRef = useRef(false);''',
"survey state")

old_effect_start = '''  /* 回答済みかどうかは「端末」ではなく「アカウント」で判定する。
     これにより、別端末でもログインすれば続き(追記)ができ、逆にセッションが
     切れただけの端末から新規回答が積み増されることもなくなる。
     同じアカウントで回答できるのは2回まで。2回目は「自由記述の追記」に限定
     (選択回答まで二度数えると、1人1票であるべき分布や平均が歪むため)。 */
  useEffect(() => {
    let alive = true;
    setAddendum(null); setLimit(null);
    (async () => {
      if (!session) return;
      const rec = await acctGet(session.name);
      if (!alive || !rec || !rec.respId) return;
      const r1 = await sGet("resp:" + rec.respId);
      if (!alive || !r1) return;
      const r2 = await sGet("resp:" + rec.respId + "-2");
      if (!alive) return;
      if (r2) setLimit({ id: rec.respId });
      else setAddendum({ id: rec.respId, base: r1 });
    })();
    return () => { alive = false; };
  }, [session]);'''
new_effect = '''  /* 回答済み判定の正本はremote account responseとする。
     localStorageの有無では初回回答へ戻さない。 */
  useEffect(() => {
    let alive = true;
    setCurrentResponse(null);
    setEditMode(null);
    (async () => {
      if (!session) return;
      setCurrentLoading(true);
      try {
        const rec = await acctGet(session.name);
        if (!alive || !rec || !rec.respId) return;
        let current = null;
        if (cloudApiEnabled() && session.token) {
          current = await cloudLoadOwnResponse(rec.respId, session.token);
        }
        if (!current) current = await sGet("resp:" + rec.respId);
        if (!alive || !current) return;
        current.remoteId = current.remoteId || rec.respId;
        current.remoteRevision = Number(current.remoteRevision || current.revision || current.seq || 1);
        current.revision = current.remoteRevision;
        setCurrentResponse(current);
      } catch (error) {
        console.warn("current response load failed", error);
      } finally {
        if (alive) setCurrentLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [session]);'''
text = replace_once(text, old_effect_start, new_effect, "current response effect")

# Initial submit is always a creation; no second POST branch.
old_base = '''    /* 追記(2回目)は、元の回答の属性・選択回答をそのまま引き継ぐ。
       集計側(mergeResponse)は seq=2 を見て、意見チャンクだけを加算する。 */
    const base = addendum
      ? {
          id: addendum.id + "-2", pid: addendum.id, seq: 2,
          ts: Date.now(), ver: APP_VER, consent: { version: policy.version, ts: Date.now() },
          demo: addendum.base.demo || {}, answers: addendum.base.answers || {}, free: free, freeQids: freeQids
        }
      : {
          id: uid(), seq: 1, ts: Date.now(), ver: APP_VER, consent: { version: policy.version, ts: Date.now() },
          demo: demo, answers: answers, free: free, freeQids: freeQids
        };'''
new_base = '''    const base = {
      id: uid(), seq: 1, ts: Date.now(), ver: APP_VER, consent: { version: policy.version, ts: Date.now() },
      demo: demo, answers: answers, free: free, freeQids: freeQids
    };'''
text = replace_once(text, old_base, new_base, "initial submit model")
text = replace_once(text,
'''    const boundId = addendum ? addendum.id : resp.id;
    await pSet("last:id", { id: boundId, ts: resp.ts });
    if (session) await acctBindResp(session.name, boundId); // アカウントに回答を紐付け''',
'''    const boundId = resp.id;
    await pSet("last:id", { id: boundId, ts: resp.ts });
    if (session) await acctBindResp(session.name, boundId); // アカウントに回答を紐付け''',
"bound response id")

# Add update actions before resetAll.
marker = "\n  async function resetAll() {"
if "async function submitCurrentFreeText" not in text:
    addition = r'''
  async function refreshCurrentResponse() {
    if (!session || !currentResponse) return null;
    const id = currentResponse.remoteId || currentResponse.id;
    const fresh = cloudApiEnabled() && session.token ? await cloudLoadOwnResponse(id, session.token) : null;
    if (fresh) {
      setCurrentResponse(fresh);
      await sSet("resp:" + id, fresh);
      return fresh;
    }
    return currentResponse;
  }

  async function submitCurrentFreeText(mode) {
    if (busyRef.current || !currentResponse) return;
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    const original = String(currentResponse.free || "");
    const nextText = mode === "append"
      ? sanitizeFreeText([original.trim(), String(editText || "").trim()].filter(Boolean).join("\n"), 1500)
      : sanitizeFreeText(editText, 1500);
    if (mode === "append" && String(editText || "").trim() && nextText.length <= original.trim().length) {
      setErr("追記後の自由記述が1500字を超えています。内容を短くしてください。");
      return;
    }
    busyRef.current = true; setErr("");
    try {
      const updated = await cloudPatchFreeText(id, revision, nextText);
      const next = {
        ...currentResponse, id: id, remoteId: id,
        free: nextText, revision: Number(updated.revision), remoteRevision: Number(updated.revision),
        analysis: null, analysisSource: "cloudflare", cloudAnalysisStatus: "pending"
      };
      await sSet("resp:" + id, next);
      setCurrentResponse(next); setEditMode(null); setEditText("");
      notify(mode === "append" ? "自由記述を追記しました。再解析を開始します" : "自由記述を更新しました。再解析を開始します");
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") {
        await refreshCurrentResponse();
        setErr("別の更新が先に反映されました。最新の回答を読み直したので、内容を確認して再度編集してください。");
      } else {
        setErr("回答の更新に失敗しました" + (error && error.code ? " (" + error.code + ")" : ""));
      }
    } finally { busyRef.current = false; }
  }

  async function submitCurrentAnswers() {
    if (busyRef.current || !currentResponse) return;
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    const editable = questions.filter(q => q.type !== "free");
    const payload = Object.fromEntries(editable.map(q => [q.id, String(answers[q.id] || "")]).filter(([, value]) => value));
    if (Object.keys(payload).length !== editable.length) {
      setErr("すべての選択式設問に回答してください。"); return;
    }
    busyRef.current = true; setErr("");
    try {
      const updated = await cloudPatchAnswers(id, revision, payload);
      const next = {
        ...currentResponse, id: id, remoteId: id,
        answers: payload, revision: Number(updated.revision), remoteRevision: Number(updated.revision),
        analysis: null, analysisSource: "cloudflare", cloudAnalysisStatus: "pending"
      };
      await sSet("resp:" + id, next);
      setCurrentResponse(next); setEditMode(null);
      notify("アンケート回答を更新しました。現在の自由記述全文を再解析します");
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") {
        await refreshCurrentResponse();
        setErr("別の更新が先に反映されました。最新の回答を読み直しました。");
      } else {
        setErr("アンケート回答の更新に失敗しました" + (error && error.code ? " (" + error.code + ")" : ""));
      }
    } finally { busyRef.current = false; }
  }

  async function retryCurrentAnalysis() {
    if (busyRef.current || !currentResponse) return;
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    busyRef.current = true; setErr("");
    try {
      await cloudRequeueAnalysis(id, revision);
      setCurrentResponse({ ...currentResponse, cloudAnalysisStatus: "pending" });
      notify("現在の回答を解析キューへ再投入しました");
    } catch (error) {
      if (error && error.code === "REVISION_CONFLICT") await refreshCurrentResponse();
      setErr("解析の再試行を開始できませんでした" + (error && error.code ? " (" + error.code + ")" : ""));
    } finally { busyRef.current = false; }
  }
'''
    if marker not in text:
        raise RuntimeError("survey action insertion marker not found")
    text = text.replace(marker, addition + marker, 1)

# Remove old limit/addendum UI and insert current response editor.
start_marker = "  /* 2回とも回答済み: これ以上は回答できない */"
end_marker = "\n  if (phase === \"consent\") {"
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise RuntimeError("legacy addendum UI boundaries not found")
current_ui = r'''  if (currentLoading && phase === "consent") {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "56px 0" }}><Spinner /></div>
    );
  }

  /* 既存回答がある場合は初回アンケートを再表示せず、同じcurrent responseを編集する。 */
  if (currentResponse && phase === "consent") {
    const id = currentResponse.remoteId || currentResponse.id;
    const revision = Number(currentResponse.remoteRevision || currentResponse.revision || currentResponse.seq || 1);
    const nonFreeQuestions = questions.filter(q => q.type !== "free");
    if (editMode === "append" || editMode === "free") {
      const append = editMode === "append";
      return (
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <H2 eyebrow={append ? "APPEND" : "EDIT"} sub={"回答ID " + id + " / revision " + revision}>
            {append ? "自由記述を追記" : "自由記述を修正"}
          </H2>
          {append && currentResponse.free ? (
            <Card style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>現在の自由記述</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 180, overflowY: "auto" }}>{currentResponse.free}</div>
            </Card>
          ) : null}
          <textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            rows={10}
            maxLength={1500}
            placeholder={append ? "追加したい内容を書いてください" : "現在の自由記述を編集してください"}
            style={{ width: "100%", padding: 12, borderRadius: 5, border: "1.5px solid " + C.rule, resize: "vertical", background: C.card, lineHeight: 1.8 }}
          />
          <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>
            {append ? "追記後の全文" : "編集後全文"}が1500字以内で保存され、全文を再解析します。
          </div>
          {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Btn onClick={() => submitCurrentFreeText(editMode)}>保存して再解析</Btn>
            <Btn kind="ghost" onClick={() => { setEditMode(null); setEditText(""); setErr(""); }}>戻る</Btn>
          </div>
        </div>
      );
    }

    if (editMode === "answers") {
      const complete = nonFreeQuestions.every(q => answers[q.id]);
      return (
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <H2 eyebrow="EDIT ANSWERS" sub={"回答ID " + id + " / revision " + revision}>アンケート回答を修正</H2>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
            初回回答時に保存された設問スナップショットに対して更新します。自由記述は変更せず、更新後に現在の全文を再解析します。
          </div>
          {nonFreeQuestions.map((q, index) => (
            <Card key={q.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{index + 1}. {q.text}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(q.options || []).map(option => (
                  <Chip key={option} active={answers[q.id] === option} onClick={() => setAnswers({ ...answers, [q.id]: option })}>{option}</Chip>
                ))}
              </div>
            </Card>
          ))}
          {err ? <div style={{ color: C.bengara, fontSize: 12, marginTop: 8 }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Btn disabled={!complete} onClick={submitCurrentAnswers}>保存して再解析</Btn>
            <Btn kind="ghost" onClick={() => { setEditMode(null); setErr(""); }}>戻る</Btn>
          </div>
        </div>
      );
    }

    return (
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
    );
  }
'''
text = text[:start] + current_ui + text[end:]

path.write_text(text, encoding="utf-8")
print("Applied Phase 4 current-response UI.")
