import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber, fvalue, groupRows, type Color } from "../../../shared/database";
import { registerCss } from "../styles";
import { Segmented } from "../ui";
import type { ViewProps } from "./types";

registerCss(
  "chart",
  `
.db-chart { position: relative; display: flex; flex-direction: column; min-width: 0; padding-bottom: 8px; }
.db-chart-head { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 2px; }
.db-chart-title { flex: 1; font-size: 13px; color: var(--n-text-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db-chart svg { display: block; overflow: visible; }
.db-chart-grid { stroke: var(--n-divider); stroke-width: 0.5; }
.db-chart-axis { fill: var(--n-text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.db-chart-bar { cursor: default; }
.db-chart-bar:hover, .db-chart-slice:hover { opacity: .82; }
.db-chart-line { fill: none; stroke: var(--n-accent); stroke-width: 2; }
.db-chart-area { fill: color-mix(in srgb, var(--n-accent) 12%, transparent); }
.db-chart-dot { fill: var(--n-surface); stroke: var(--n-accent); stroke-width: 2; }
.db-chart-tip { position: absolute; pointer-events: none; transform: translate(-50%, calc(-100% - 8px)); background: var(--n-tooltip); color: var(--n-tooltip-text); border: none; box-shadow: 0 0 0 0.5px var(--n-tooltip-ring), var(--n-shadow-tooltip); border-radius: var(--n-r-control, 4px); padding: 5px 6.5px; font-size: var(--n-t-caption, 11px); white-space: nowrap; z-index: 3; }
.db-chart-tip b { font-weight: 600; }
.db-chart-donut { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; justify-content: center; }
.db-chart-legend { display: flex; flex-direction: column; gap: 6px; font-size: 13px; min-width: 140px; }
.db-chart-legend-row { display: flex; align-items: center; gap: 8px; }
.db-chart-legend-row span:nth-child(2) { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.db-chart-legend-row span:last-child { color: var(--n-text-2); font-variant-numeric: tabular-nums; }
.db-chart-swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.db-chart-hint { padding: 48px 16px; text-align: center; color: var(--n-text-2); font-size: var(--n-t-body, 13px); }
`,
);

const PALETTE: Color[] = ["blue", "green", "orange", "purple", "pink", "yellow", "red", "brown", "gray"];
const fillOf = (color: Color, i: number) => `var(--n-${color === "default" ? PALETTE[i % PALETTE.length] : color})`;

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

type Datum = { key: string; label: string; value: number; color: Color };

export function ChartView(p: ViewProps) {
  const { m, view, result, actions } = p;
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const [tip, setTip] = useState<{ x: number; y: number; label: string; value: string } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(240, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  const byProp = m.schema.find((x) => x.id === view.chartBy);
  const valueProp = view.chartAgg !== "count" ? m.schema.find((x) => x.id === view.chartValue && (x.type === "number" || x.type === "formula" || x.type === "rollup")) : undefined;
  const data = useMemo<Datum[]>(() => {
    if (!byProp) return [];
    const groups = groupRows(m.ctx, result.rows, { prop: byProp.id, date: "month", text: "exact", status: "option", step: 10, sort: "manual", hideEmpty: true }, view.groups);
    return groups
      .filter((g) => !g.hidden)
      .map((g) => {
        let value = g.rows.length;
        if (valueProp) {
          const nums = g.rows.map((r) => fvalue(m.ctx, r, valueProp)).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
          const sum = nums.reduce((a, b) => a + b, 0);
          value = view.chartAgg === "sum" ? sum : nums.length ? sum / nums.length : 0;
        }
        return { key: g.key, label: g.label || "Empty", value: Math.round(value * 100) / 100, color: g.color };
      });
  }, [byProp, valueProp, result.rows, m.ctx, view.groups, view.chartAgg]);
  const fmt = (v: number) => (valueProp?.type === "number" ? formatNumber(v, valueProp.format) : formatNumber(v, "commas"));
  const aggLabel = view.chartAgg === "count" || !valueProp ? "Count" : `${view.chartAgg === "sum" ? "Sum" : "Average"} of ${valueProp.name}`;

  const head = (
    <div className="db-chart-head">
      <span className="db-chart-title">{byProp ? `${aggLabel} by ${byProp.name}` : ""}</span>
      {p.editable && (
        <Segmented
          testId="db-chart-type"
          value={view.chartType}
          options={[
            { id: "bar", label: "Bar" },
            { id: "line", label: "Line" },
            { id: "donut", label: "Donut" },
          ]}
          onChange={(v) => actions.updateView(view.id, { chartType: v })}
        />
      )}
    </div>
  );

  if (!byProp)
    return (
      <div className="db-chart" data-testid="db-chart" ref={box}>
        <div className="db-chart-hint">Pick a property to group by in Layout</div>
      </div>
    );

  const H = 300;
  const pad = { l: 44, r: 12, t: 12, b: 44 };
  const plotW = width - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const top = Math.max(0, ...data.map((d) => d.value));
  const integral = data.every((d) => Number.isInteger(d.value));
  let step = niceMax(top / 4 || 1);
  if (integral) step = Math.max(1, Math.ceil(step));
  const max = Math.max(step, Math.ceil(top / step) * step);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const slot = data.length ? plotW / data.length : plotW;
  const showTip = (e: React.MouseEvent, d: Datum) => {
    const r = box.current!.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, label: d.label, value: fmt(d.value) });
  };
  const truncate = (s: string) => {
    const n = Math.max(3, Math.floor(slot / 7));
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  };

  let body: React.ReactNode;
  if (!data.length) body = <div className="db-chart-hint">No data to show</div>;
  else if (view.chartType === "donut") {
    const total = data.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
    const R = 110;
    const r = 66;
    let angle = -Math.PI / 2;
    const arcs = data.map((d, i) => {
      const sweep = (Math.max(0, d.value) / total) * Math.PI * 2;
      const a0 = angle;
      const a1 = angle + Math.min(sweep, Math.PI * 2 - 0.0001);
      angle += sweep;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const pt = (rad: number, a: number) => `${R + 10 + rad * Math.cos(a)} ${R + 10 + rad * Math.sin(a)}`;
      const path = `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`;
      return sweep > 0 ? <path key={d.key} className="db-chart-slice db-chart-bar" data-testid="db-chart-bar" d={path} fill={fillOf(d.color, i)} onMouseMove={(e) => showTip(e, d)} onMouseLeave={() => setTip(null)} /> : null;
    });
    body = (
      <div className="db-chart-donut">
        <svg width={(R + 10) * 2} height={(R + 10) * 2}>
          {arcs}
          <text x={R + 10} y={R + 6} textAnchor="middle" className="db-chart-axis" style={{ fontSize: 22, fill: "var(--n-text)", fontWeight: 600 }}>
            {fmt(data.reduce((a, d) => a + d.value, 0))}
          </text>
          <text x={R + 10} y={R + 26} textAnchor="middle" className="db-chart-axis">
            {aggLabel}
          </text>
        </svg>
        <div className="db-chart-legend">
          {data.map((d, i) => (
            <div key={d.key} className="db-chart-legend-row">
              <span className="db-chart-swatch" style={{ background: fillOf(d.color, i) }} />
              <span>{d.label}</span>
              <span>{fmt(d.value)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    const points = data.map((d, i) => ({ d, x: pad.l + slot * i + slot / 2, y: y(d.value) }));
    body = (
      <svg width={width} height={H}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="db-chart-grid" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
            <text className="db-chart-axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {view.chartType === "bar" &&
          data.map((d, i) => {
            const bw = Math.max(4, Math.min(56, slot * 0.6));
            const x = pad.l + slot * i + (slot - bw) / 2;
            return <rect key={d.key} className="db-chart-bar" data-testid="db-chart-bar" x={x} y={y(d.value)} width={bw} height={Math.max(0, pad.t + plotH - y(d.value))} rx={3} fill={fillOf(d.color, i)} onMouseMove={(e) => showTip(e, d)} onMouseLeave={() => setTip(null)} />;
          })}
        {view.chartType === "line" && (
          <>
            <path className="db-chart-area" d={`M ${points[0]!.x} ${pad.t + plotH} ${points.map((pt) => `L ${pt.x} ${pt.y}`).join(" ")} L ${points.at(-1)!.x} ${pad.t + plotH} Z`} />
            <polyline className="db-chart-line" points={points.map((pt) => `${pt.x},${pt.y}`).join(" ")} />
            {points.map((pt) => (
              <circle key={pt.d.key} className="db-chart-dot db-chart-bar" data-testid="db-chart-bar" cx={pt.x} cy={pt.y} r={4} onMouseMove={(e) => showTip(e, pt.d)} onMouseLeave={() => setTip(null)} />
            ))}
          </>
        )}
        {points.map((pt) => (
          <text key={pt.d.key} className="db-chart-axis" x={pt.x} y={pad.t + plotH + 18} textAnchor="middle">
            {truncate(pt.d.label)}
          </text>
        ))}
        <line className="db-chart-grid" x1={pad.l} x2={width - pad.r} y1={pad.t + plotH} y2={pad.t + plotH} style={{ strokeWidth: 1 }} />
      </svg>
    );
  }

  return (
    <div className="db-chart" data-testid="db-chart" ref={box}>
      {head}
      {body}
      {tip && (
        <div className="db-chart-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.label}: <b>{tip.value}</b>
        </div>
      )}
    </div>
  );
}
