"use client";

// Plot overlay for the "Define part" mode: measure distances along the outline
// of ANY piece (start on one piece's outline, the end follows that outline),
// show the running distance at the cursor, accept a typed distance, and draw
// the named measurement points (d_1, d_2, …) plus the live preview of the
// part being defined.

import { useEffect, useMemo, useRef, useState } from "react";
import type { GeometryResult } from "@/lib/geometry";
import {
  arcAt,
  arcDistance,
  arcPolyline,
  buildArcTable,
  pointAtArc,
  snapToBoundary,
  type BoundarySeg,
  type Vec2,
} from "@/lib/split";

/** A finished measurement as reported to the page. */
export interface DefineMeasured {
  pieceId: string;
  from: { line: string; point: Vec2 };
  to: { line: string; point: Vec2 };
  /** Measured length (cm): the typed value or the distance to the click. */
  dist: number;
  /** True if `dist` runs the LONGER way round the outline. */
  long: boolean;
}

export interface DefineOverlay {
  mode: "measure" | "formula";
  /** Outer outlines of all pieces (measurable). */
  loops: { pieceId: string; loop: BoundarySeg[] }[];
  /** Measurement points created so far, with their names. */
  marks: { name: string; point: Vec2 }[];
  /** Name the next measurement will get (shown at the cursor), e.g. "d_3". */
  nextName: string;
  onMeasured: (m: DefineMeasured) => void;
  /** Live preview of the part being defined (formula mode). */
  preview: GeometryResult | null;
}

function parseDistance(s: string): number | null {
  if (!/^\d*[.,]?\d*$/.test(s) || !/\d/.test(s)) return null;
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

interface Hit { loopIdx: number; segIndex: number; t: number; point: Vec2; line: string }

export function DefineLayer({
  overlay,
  box,
  unit,
  toGeom,
}: {
  overlay: DefineOverlay;
  box: { x: number; y: number; w: number; h: number };
  unit: number;
  toGeom: (clientX: number, clientY: number) => Vec2;
}) {
  const { loops, marks, mode } = overlay;
  const tabs = useMemo(() => loops.map((l) => buildArcTable(l.loop)), [loops]);
  const [start, setStart] = useState<{ loopIdx: number; s: number; point: Vec2; line: string } | null>(null);
  const [hover, setHover] = useState<{ s: number; point: Vec2; cursor: Vec2 } | null>(null);
  const [focus, setFocus] = useState<Vec2 | null>(null);
  const [typed, setTyped] = useState("");

  // Leaving measure mode discards an unfinished measurement.
  useEffect(() => {
    setStart(null); setHover(null); setTyped(""); setFocus(null);
  }, [mode]);

  // Snap onto an outline — only the start's outline once a measurement runs —
  // preferring measurement points and outline corners within a small radius.
  function snap(g: Vec2): Hit | null {
    const idxs = start ? [start.loopIdx] : loops.map((_, i) => i);
    const targets: Vec2[] = [...marks.map((m) => m.point)];
    for (const i of idxs) for (const s of loops[i].loop) targets.push(s.bezier[0]);
    let target: Vec2 | null = null;
    let bestD = unit * 2.5;
    for (const q of targets) {
      const d = Math.hypot(q.x - g.x, q.y - g.y);
      if (d <= bestD) { bestD = d; target = q; }
    }
    const p = target ?? g;
    let best: Hit | null = null;
    let bestDist = Infinity;
    for (const i of idxs) {
      const s = snapToBoundary(loops[i].loop, p);
      if (s && s.dist < bestDist) {
        bestDist = s.dist;
        best = { loopIdx: i, segIndex: s.segIndex, t: s.t, point: target ? { ...target } : s.point, line: s.line };
      }
    }
    return best;
  }

  const measure = useMemo(() => {
    if (!start || !hover) return null;
    const tab = tabs[start.loopIdx];
    const live = arcDistance(tab, start.s, hover.s);
    const tv = typed ? parseDistance(typed) : null;
    const tooLong = tv != null && tv > tab.total;
    const dist = tv != null && !tooLong ? tv : live.dist;
    return {
      dist,
      end: pointAtArc(tab, start.s + live.dir * dist),
      long: dist > tab.total / 2 + 1e-9,
      invalid: typed !== "" && (tv == null || tooLong),
      path: arcPolyline(tab, start.s, dist, live.dir),
    };
  }, [start, hover, typed, tabs]);

  function finish(end: { line: string; point: Vec2 }, dist: number, long: boolean) {
    if (!start) return;
    overlay.onMeasured({
      pieceId: loops[start.loopIdx].pieceId,
      from: { line: start.line, point: start.point },
      to: end,
      dist,
      long,
    });
    setStart(null);
    setTyped("");
  }

  function onMove(e: React.MouseEvent) {
    const g = toGeom(e.clientX, e.clientY);
    const h = snap(g);
    setFocus(h ? h.point : null);
    if (h && start) setHover({ s: arcAt(tabs[start.loopIdx], h.segIndex, h.t), point: h.point, cursor: g });
  }

  function onDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const h = snap(toGeom(e.clientX, e.clientY));
    if (!h) return;
    if (!start) {
      const s = arcAt(tabs[h.loopIdx], h.segIndex, h.t);
      setStart({ loopIdx: h.loopIdx, s, point: h.point, line: h.line });
      setHover({ s, point: h.point, cursor: h.point });
      setTyped("");
    } else {
      // A click measures to the clicked point (a typed value is used on Enter).
      const tab = tabs[start.loopIdx];
      const d = arcDistance(tab, start.s, arcAt(tab, h.segIndex, h.t)).dist;
      finish({ line: h.line, point: h.point }, d, false);
    }
  }

  // Keyboard: digits/./, type a distance, Backspace edits, Enter measures,
  // Esc clears the typed value, then cancels. Ignored while typing in inputs.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return;
    if (/^[0-9.,]$/.test(e.key)) setTyped((t) => t + e.key);
    else if (e.key === "Backspace") setTyped((t) => t.slice(0, -1));
    else if (e.key === "Enter") {
      if (!measure || measure.invalid) return;
      finish({ line: measure.end.line, point: measure.end.point }, measure.dist, measure.long);
    } else if (e.key === "Escape") {
      if (typed) setTyped(""); else setStart(null);
    } else return;
    e.preventDefault();
  };
  const active = mode === "measure" && start != null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const previewPaths = overlay.preview ? Object.entries(overlay.preview.paths) : [];

  return (
    <g>
      {mode === "measure" && (
        <rect
          x={box.x} y={box.y} width={box.w} height={box.h}
          fill="transparent" style={{ cursor: "crosshair" }}
          onMouseMove={onMove} onMouseDown={onDown}
        />
      )}

      {/* Live preview of the part being defined (dashed blue). */}
      {previewPaths.map(([k, d]) => (
        <path
          key={k} d={d} fill="none" pointerEvents="none"
          stroke={overlay.preview!.lineTypes[k] === "aux" ? "#9ab" : "#1a73e8"}
          strokeWidth={unit * 0.9} strokeDasharray={`${unit * 2} ${unit * 1.2}`}
        />
      ))}

      {/* Snapped focus point. */}
      {mode === "measure" && focus && (
        <g pointerEvents="none">
          <circle cx={focus.x} cy={focus.y} r={unit * 1.8} fill="none" stroke="#2b8a3e" strokeWidth={unit * 0.5} />
          <circle cx={focus.x} cy={focus.y} r={unit * 0.6} fill="#2b8a3e" />
        </g>
      )}

      {/* Named measurement points. */}
      {marks.map((m) => {
        const r = unit * 1.6;
        return (
          <g key={m.name} pointerEvents="none">
            <path
              d={`M ${m.point.x} ${m.point.y - r} L ${m.point.x + r} ${m.point.y} L ${m.point.x} ${m.point.y + r} L ${m.point.x - r} ${m.point.y} Z`}
              fill="#7b2cbf" stroke="#fff" strokeWidth={unit * 0.35}
            />
            <text x={m.point.x + r * 1.3} y={m.point.y - r * 1.2} fontSize={unit * 3.6} fill="#5a189a" fontWeight={700}>
              {m.name}
            </text>
          </g>
        );
      })}

      {/* Running measurement. */}
      {mode === "measure" && start && (
        <circle cx={start.point.x} cy={start.point.y} r={unit * 1.4}
          fill="#2b8a3e" stroke="#fff" strokeWidth={unit * 0.4} pointerEvents="none" />
      )}
      {mode === "measure" && measure && hover && (() => {
        const label = `${overlay.nextName} = ${typed !== "" ? `${typed}▏` : measure.dist.toFixed(1)} cm`;
        const fs = unit * 3.6;
        const padX = fs * 0.4;
        const tw = label.length * fs * 0.6 + padX * 2;
        const tx = hover.cursor.x + unit * 2.5;
        const ty = hover.cursor.y - unit * 2.5;
        const color = measure.invalid ? "#d6336c" : "#2b8a3e";
        return (
          <g pointerEvents="none">
            <polyline
              points={measure.path.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none" stroke="#2b8a3e" strokeOpacity={0.55}
              strokeWidth={unit * 1.6} strokeLinecap="round" strokeLinejoin="round"
            />
            <circle cx={measure.end.point.x} cy={measure.end.point.y} r={unit * 1.6}
              fill="none" stroke="#7b2cbf" strokeWidth={unit * 0.6} />
            <rect x={tx} y={ty - fs * 1.1} width={tw} height={fs * 1.5} rx={fs * 0.3}
              fill="#fff" stroke={color} strokeWidth={unit * 0.35} opacity={0.95} />
            <text x={tx + padX} y={ty} fontSize={fs} fill={color}
              fontFamily="ui-monospace, Menlo, monospace" fontWeight={600}>
              {label}
            </text>
          </g>
        );
      })()}
    </g>
  );
}
