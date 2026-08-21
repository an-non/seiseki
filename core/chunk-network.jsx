/* Optional React renderer for the independent chunk-level network. */
function ChunkNetwork({ agg, onPick }) {
  const data = useMemo(() => chunkNetwork(agg), [agg]);
  const [phase, setPhase] = useState(0);
  const [motion] = useState(() => typeof window === "undefined" || !window.matchMedia || !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const placed = useMemo(() => chunkNetworkLayout(data.nodes, 340, 340, 42, 264), [data]);
  const pos = {};
  const points = placed.map(node => {
    const base = chunkNodeSeed(node.id) * Math.PI * 2;
    const amount = motion ? 1 + node.centrality * 3 : 0;
    const point = { x: node.x + Math.cos(phase * 0.52 + base) * amount, y: node.y + Math.sin(phase * 0.66 + base * 1.17) * amount };
    pos[node.id] = point;
    return point;
  });

  useEffect(() => {
    if (!motion || typeof requestAnimationFrame !== "function") return undefined;
    let raf = 0;
    const started = performance.now();
    const tick = now => { setPhase((now - started) / 1000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motion]);

  if (!placed.length) return <div style={{ padding: 18, color: C.sub }}>チャンクがありません。</div>;
  let maxDegree = 1;
  for (const node of placed) if (node.degree > maxDegree) maxDegree = node.degree;
  const labelOf = text => text.length > 18 ? text.slice(0, 18) + "..." : text;
  return (
    <svg viewBox="0 0 680 680" style={{ width: "100%", maxWidth: 680, height: "auto", display: "block", margin: "0 auto" }}>
      {placed.map(node => <line key={"c" + node.id} x1={340} y1={340} x2={pos[node.id].x} y2={pos[node.id].y} stroke={C.rule} strokeOpacity={0.48} strokeWidth={1} />)}
      {data.links.map(link => {
        const a = pos[link.a], b = pos[link.b];
        if (!a || !b) return null;
        return <line key={link.a + "__" + link.b} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={chunkLinkColor(link.primary)} strokeOpacity={0.24 + link.weight * 0.4} strokeWidth={0.7 + link.weight * 2.2}><title>{link.reasons.join(" / ")}</title></line>;
      })}
      {placed.map((node, index) => {
        const p = points[index];
        const radius = 6 + Math.sqrt(node.crit / 100) * 10 + (node.degree / maxDegree) * 5;
        return <g key={node.id} className="visual-action" role="button" tabIndex={0}
          onClick={() => onPick && onPick(node)}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick && onPick(node); } }}>
          <title>{node.text + " / " + (node.topic || "その他") + " / 接続 " + node.degree}</title>
          <circle cx={p.x} cy={p.y} r={radius} fill={chunkWeightColor(node.weightView)} stroke={C.paper} strokeWidth={2} />
          <text x={p.x} y={p.y + radius + 12} textAnchor="middle" fontSize={10} fill={C.ink} fontFamily={FONT_BODY} style={{ pointerEvents: "none" }}>{labelOf(node.text)}</text>
        </g>;
      })}
      <g>
        <rect x={302} y={318} width={76} height={44} rx={8} fill={C.slate} stroke={C.paper} strokeWidth={2.5} />
        <text x={340} y={340} textAnchor="middle" dominantBaseline="central" fontSize={16} fontWeight="700" fill="#FFFFFF" fontFamily={FONT_DISP}>政治</text>
      </g>
    </svg>
  );
}
