// Defining a NEW pattern part from measurements ("Define part" mode).
//
// The user measures distances along the outlines of existing pieces; each
// measurement becomes a named variable d_1, d_2, … that the new part's JSON
// definition (same format as a part file) can use in its formulas.
//
//  • absolute measurement → a fixed number (cm);
//  • relative measurement → stored as positions on lines (line + t along the
//    line's definition direction, like cut anchors) and RE-MEASURED on every
//    replay, so the new part follows when body measurements change.
//
// The whole definition is one `definePart` edit in the pattern history.

import { collectVariables, evaluatePart, type GeometryResult } from "./geometry";
import {
  arcAt,
  arcDistance,
  boundarySegments,
  buildArcTable,
  extractOuterBoundary,
  nearestParamOnBezier,
  parsePathBezier,
  bezierAt,
  type SplitAnchor,
} from "./split";
import type { Measurements, PartDef } from "./types";

/** One named measurement (d_1, d_2, …). `value` is the length (cm) when it
 *  was measured — the fixed value for absolute measurements, and the fallback
 *  for relative ones if their piece/lines can't be found any more. */
export type PartMeasure =
  | { name: string; kind: "absolute"; value: number }
  | {
      name: string;
      kind: "relative";
      value: number;
      /** Piece whose outline was measured. */
      part: string;
      from: SplitAnchor;
      to: SplitAnchor;
      /** True if the measured stretch was the LONGER way round the outline. */
      long?: boolean;
    };

/** Name of the n-th (1-based) measurement. */
export const measureName = (n: number) => `d_${n}`;

/**
 * Re-measure a relative distance on a piece: the length along its outer
 * outline between the two anchors (shorter way, or the longer one if `long`).
 * Orientation-independent, so it survives the outline walk flipping direction.
 * Null if the outline or an anchor line can't be resolved.
 */
export function measureRelative(g: GeometryResult, from: SplitAnchor, to: SplitAnchor, long?: boolean): number | null {
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return null;
  const tab = buildArcTable(ob.loop);
  const arcPos = (a: SplitAnchor): number | null => {
    const def = parsePathBezier(g.paths[a.line]);
    const i = ob.loop.findIndex((s) => s.line === a.line);
    if (!def || i < 0) return null;
    const p = bezierAt(def, a.t);
    return arcAt(tab, i, nearestParamOnBezier(ob.loop[i].bezier, p));
  };
  const s1 = arcPos(from);
  const s2 = arcPos(to);
  if (s1 == null || s2 == null) return null;
  const short = arcDistance(tab, s1, s2).dist;
  return long ? tab.total - short : short;
}

/** Current values of the measurements, by name (relative ones re-measured on
 *  `pieces`, falling back to the value stored at measuring time). */
export function measureValues(
  measures: PartMeasure[],
  pieces: Map<string, GeometryResult> | ((id: string) => GeometryResult | undefined)
): Record<string, number> {
  const get = typeof pieces === "function" ? pieces : (id: string) => pieces.get(id);
  const out: Record<string, number> = {};
  for (const m of measures) {
    if (m.kind === "absolute") {
      out[m.name] = m.value;
    } else {
      const g = get(m.part);
      const v = g ? measureRelative(g, m.from, m.to, m.long) : null;
      out[m.name] = v ?? m.value;
    }
  }
  return out;
}

/** Default definition: a rectangle whose width is d_1 and height d_2 when
 *  those were measured, else 10 cm × 3 cm. */
export function rectangleTemplate(measureNames: string[]): PartDef {
  const width = measureNames[0] ?? "10";
  const height = measureNames[1] ?? "3";
  return {
    local_variables: { width, height },
    points: {
      A: { x: "0", y: "0", pointType: "marker", position: "top-left" },
      B: { x: "width", y: "0", pointType: "marker", position: "top-right" },
      C: { x: "width", y: "height", pointType: "marker", position: "bottom-right" },
      D: { x: "0", y: "height", pointType: "marker", position: "bottom-left" },
    },
    lines: {
      L1: { lineType: "seam", linePointReferences: ["A", "A", "B", "B"] },
      L2: { lineType: "seam", linePointReferences: ["B", "B", "C", "C"] },
      L3: { lineType: "seam", linePointReferences: ["C", "C", "D", "D"] },
      L4: { lineType: "seam", linePointReferences: ["D", "D", "A", "A"] },
    },
  };
}

/** Parse + minimally validate a part definition typed by the user. */
export function parsePartDef(text: string): { def: PartDef | null; error: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { def: null, error: `JSON: ${(err as Error).message}` };
  }
  const d = raw as Partial<PartDef>;
  if (!d || typeof d !== "object" || Array.isArray(d)) return { def: null, error: "The definition must be a JSON object." };
  if (!d.points || typeof d.points !== "object") return { def: null, error: 'Missing "points" object.' };
  if (!d.lines || typeof d.lines !== "object") return { def: null, error: 'Missing "lines" object.' };
  for (const [name, l] of Object.entries(d.lines)) {
    if (!Array.isArray(l?.linePointReferences) || l.linePointReferences.length !== 4) {
      return { def: null, error: `Line "${name}" needs "linePointReferences" with 4 point names.` };
    }
  }
  return { def: d as PartDef, error: null };
}

function shift(g: GeometryResult, dx: number, dy: number): GeometryResult {
  const NUM = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  const points: GeometryResult["points"] = {};
  for (const [k, p] of Object.entries(g.points)) points[k] = { ...p, x: p.x + dx, y: p.y + dy };
  const paths: GeometryResult["paths"] = {};
  for (const [k, d] of Object.entries(g.paths)) {
    let i = 0;
    paths[k] = d.replace(NUM, (t) => String(parseFloat(t) + (i++ % 2 === 0 ? dx : dy)));
  }
  const b = g.bbox;
  const circles = g.circles
    ? Object.fromEntries(Object.entries(g.circles).map(([k, c]) => [k, { ...c, cx: c.cx + dx, cy: c.cy + dy }]))
    : undefined;
  return {
    ...g, points, paths,
    bbox: b ? { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy } : null,
    ...(circles ? { circles } : {}),
  };
}

/**
 * Evaluate a defined part: scope = pattern variables (body measurements …),
 * then the part's own user variables, then the measurement values (d_1 …).
 * Unknown names default to 0 (as for loaded parts). The result is moved so its
 * top-left corner sits at `at`. Null if nothing drawable came out.
 */
export function evaluateDefinedPart(
  def: PartDef,
  values: Record<string, number>,
  vars: Measurements,
  at: { x: number; y: number }
): GeometryResult | null {
  const scope: Measurements = { ...vars, ...(def.part_specific_user_definable_variables ?? {}), ...values };
  for (const v of collectVariables(def)) if (!(v in scope)) scope[v] = 0;
  let g: GeometryResult;
  try {
    g = evaluatePart(def, scope);
  } catch {
    return null;
  }
  if (!g.bbox) return null;
  return shift(g, at.x - g.bbox.minX, at.y - g.bbox.minY);
}

/** Where to put a new part: to the right of everything on the plot. */
export function placementRightOf(pieces: { geometry: GeometryResult }[], gap = 5): { x: number; y: number } {
  let maxX = -Infinity, minY = Infinity;
  for (const p of pieces) {
    const b = p.geometry.bbox;
    if (!b) continue;
    maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY);
  }
  return Number.isFinite(maxX) ? { x: maxX + gap, y: minY } : { x: 0, y: 0 };
}
