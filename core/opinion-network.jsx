/* Opinion network view: the only animated visualization in the current UI. */
function opinionNodeSeed(value) {
  let h = 2166136261;
  for (const ch of String(value)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

function OpinionNetwork({ agg, onPick }) {
  const data = useMemo(() => opinionNetwork(agg), [agg]);
  const [phase, setPhase] = useState(0);
  const [motion] = useState(() => typeof window === "undefined" || !window.matchMedia || !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const placed = useMemo(() => networkLayout(data.nodes, 340, 340, 104, 274), [data]);

  useEffect(() => {
    if (!motion || typeof requestAnimationFrame !== "function") return undefined;
    let raf = 0;
    const started = performance.now();
    const tick = now => {
      setPhase((now - started) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motion]);

  if (!data.nodes.length) {
    return <div style={{ minHeight: 150, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 18, fontSize: 13, color: C.sub, lineHeight: 1.9 }}>意見ネットワークに使える意見チャンクがありません。</div>;
  }

  const S = 680, cx = S / 2, cy = S / 2;
  const pos = {};
  const pointFor = (pn, index) => {
    const base = opinionNodeSeed(pn.name) * Math.PI * 2;
    const amount = motion ? 1.2 + pn.hn * 3.8 : 0;
    const x = pn.x + Math.cos(phase * 0.65 + base) * amount;
    const y = pn.y + Math.sin(phase * 0.82 + base * 1.13) * amount;
    const point = { x, y };
    pos[pn.name] = point;
    return point;
  };
  const points = placed.map(pointFor);
  let maxN = 1, maxL = 1;
  for (const pn of placed) if (pn.n > maxN) maxN = pn.n;
  for (const link of data.links) if (link.n > maxL) maxL = link.n;
  const radiusOf = pn => 13 + Math.sqrt(pn.n / maxN) * 25;
  const textColor = pn => pn.hn > 0.58 ? "#FFFFFF" : C.ink;

  return (
    <svg viewBox={"0 0 " + S + " " + S} style={{ width: "100%", maxWidth: 680, height: "auto", display: "block", margin: "0 auto" }}>
      {placed.map((pn, i) => {
        const p = points[i];
        return <line key={"c" + pn.name} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke={C.rule} strokeOpacity={0.48} strokeWidth={1} />;
      })}
      {data.links.map(link => {
        const a = pos[link.a], b = pos[link.b];
        if (!a || !b) return null;
        return <line key={link.a + "__" + link.b} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={C.slate} strokeOpacity={0.52} strokeWidth={0.8 + (link.n / maxL) * 2.8}><title>{link.a + " と " + link.b + " の共起 " + link.n + "件"}</title></line>;
      })}
      {placed.map((pn, i) => {
        const p = points[i], r = radiusOf(pn);
        return (
          <g key={pn.name} className="visual-action" role="button" tabIndex={0}
            onClick={() => onPick && onPick(pn)}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick && onPick(pn); } }}>
            <title>{pn.name + " / " + pn.n + "件 / 熱量 " + Math.round(pn.hn * 100) + " / 感情 " + emoToPos(pn.emo)}</title>
            <circle cx={p.x} cy={p.y} r={r} fill={heatColor(pn.hn)} stroke={C.paper} strokeWidth={2.5} />
            <text x={p.x} y={p.y + r + 13} textAnchor="middle" fontSize={12} fontWeight="700" fill={C.ink} fontFamily={FONT_BODY} style={{ pointerEvents: "none" }}>{pn.name}</text>
            <text x={p.x} y={p.y + r + 26} textAnchor="middle" fontSize={10} fill={C.sub} fontFamily={FONT_MONO} style={{ pointerEvents: "none" }}>{pn.n + "件"}</text>
          </g>
        );
      })}
      <g>
        <rect x={cx - 38} y={cy - 22} width={76} height={44} rx={8} fill={C.bengara} stroke={C.paper} strokeWidth={2.5} />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="central" fontSize={17} fontWeight="700" fill="#FFFFFF" fontFamily={FONT_DISP}>全意見</text>
      </g>
    </svg>
  );
}
