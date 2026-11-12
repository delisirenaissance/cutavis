// Smoothing: replace ≥ 2 consecutive outline lines of a piece by ONE cubic
// Bézier that approximates them (e.g. the jagged border left after a merge).
//
// Fit: the new curve keeps the chain's two end points (so it still joins the
// neighbouring lines) and its two control points are found by weighted least
// squares against points sampled evenly along the chain. Each sample is
// weighted by the length of the line it lies on, so a line's total influence
// grows with the square of its length: long lines are followed closely, short
// jags and steps hardly pull on the curve. A few reparameterization passes
// (Newton steps of each sample's curve parameter) refine the fit.

import { boundsWithCircles, type GeometryResult } from "./geometry";
import {
  bezierAt,
  bezierToPath,
  boundarySegments,
  extractOuterBoundary,
  type Bezier,
  type BoundarySeg,
  type Vec2,
} from "./split";
import type { LineSpec } from "./types";

/** Name used for the new smoothed line (made unique per piece). */
export const SMOOTH_LINE = "smooth";

// ── Run detection ─────────────────────────────────────────────────────────────

export interface SmoothRun {
  /** The selected outline segments in loop order (oriented along the loop). */
  segs: BoundarySeg[];
  /** Their line names in loop order. */
  lines: string[];
}

/** Lines at most this long (cm) need not be clicked: a gap made only of such
 *  lines between two selected lines is included in the run automatically. */
export const SMOOTH_SKIP_MAX_CM = 1;

/**
 * Order the selected lines along the piece's outer outline and check that they
 * form ONE consecutive run (it may wrap around the loop start).
 *
 * Gaps between selected lines that consist only of short lines (each
 * ≤ SMOOTH_SKIP_MAX_CM, e.g. the tiny bridges left by a merge) are filled in
 * automatically, so those lines don't have to be clicked. Short lines beyond
 * the ends of the selection are not added.
 *
 * Returns null if fewer than 2 lines are selected, a line isn't on the outline,
 * the selection is still split into several runs, or it covers the whole
 * outline.
 */
export function findSmoothRun(g: GeometryResult, lines: string[]): SmoothRun | null {
  if (lines.length < 2) return null;
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return null;
  const loop = ob.loop;
  const n = loop.length;
  const sel = new Set(lines);
  const inSel = loop.map((s) => sel.has(s.line));
  if (inSel.filter(Boolean).length !== sel.size) return null; // some line not on the outline

  // Gaps (maximal stretches of unselected segments), each lying between two
  // selected segments — walk the loop starting at a selected one.
  const lens = loop.map((s) => segLength(s.bezier));
  const first = inSel.indexOf(true);
  const gaps: number[][] = [];
  let cur: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (!inSel[i]) cur.push(i);
    else if (cur.length) { gaps.push(cur); cur = []; }
  }
  const isShort = (gap: number[]) => gap.every((i) => lens[i] <= SMOOTH_SKIP_MAX_CM);
  const gapLen = (gap: number[]) => gap.reduce((a, i) => a + lens[i], 0);
  let fill = gaps.filter(isShort);
  // Never close the loop: if every gap is short, keep the longest one open.
  if (fill.length === gaps.length && gaps.length > 0) {
    const longest = gaps.reduce((a, b) => (gapLen(b) > gapLen(a) ? b : a));
    fill = fill.filter((gp) => gp !== longest);
  }
  for (const gp of fill) for (const i of gp) inSel[i] = true;

  const count = inSel.filter(Boolean).length;
  if (count >= n) return null; // can't replace the whole outline by one curve
  // Exactly one run start: a selected segment whose predecessor isn't selected.
  const starts = inSel.map((on, i) => on && !inSel[(i - 1 + n) % n]).map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (starts.length !== 1) return null;
  const segs: BoundarySeg[] = [];
  for (let k = 0, i = starts[0]; k < count; k++, i = (i + 1) % n) segs.push(loop[i]);
  return { segs, lines: segs.map((s) => s.line) };
}

// ── Replay: robust re-identification of a stored run ──────────────────────────
// Names of generated lines ("cut", "merge", "smooth" with "#n" suffixes) and of
// duplicate fragments ("L12#2") are assigned in outline-walk order, which can
// change when measurements change — so the stored names may point at other
// lines after a resize (e.g. "merge" ↔ "merge#2"). On replay the run is
// therefore matched by line KIND and ORDER instead of exact names.

const GENERATED = new Set(["cut", "merge", "smooth"]);

/** Kind of a line: the base name without "#n" / "~…" suffixes, e.g.
 *  "merge#3" → "merge", "L12#2" → "L12". */
function lineKind(name: string): string {
  return name.split("#")[0].split("~")[0];
}

/**
 * Find the stored run on the current outline. The stored sequence (in outline
 * order at commit time) is searched as a consecutive run in either walk
 * direction, comparing line kinds; a "merge" bridge from the stored sequence
 * may be missing (its gap closed to zero). Line lengths play no role. Among
 * several matches the one with the most exactly matching names wins.
 */
export function resolveStoredRun(g: GeometryResult, stored: string[]): SmoothRun | null {
  if (stored.length < 2) return null;
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return null;
  const loop = ob.loop;
  const n = loop.length;
  const pat = stored.map(lineKind);

  let best: { idx: number[]; score: number } | null = null;
  for (const dir of [1, -1]) {
    for (let start = 0; start < n; start++) {
      // Walk the loop from `start`, consuming pattern tokens; optional merges.
      const idx: number[] = [];
      let score = 0;
      let p = 0;
      let k = 0;
      let ok = true;
      while (p < pat.length) {
        if (k >= n) { ok = false; break; }
        const i = (((start + dir * k) % n) + n) % n;
        const name = loop[i].line;
        if (lineKind(name) === pat[p]) {
          idx.push(i);
          if (name === stored[p]) score++;
          p++;
          k++;
        } else if (pat[p] === "merge") {
          p++; // the stored bridge no longer exists → skip it
        } else {
          ok = false;
          break;
        }
      }
      if (!ok || idx.length < 2 || idx.length >= n) continue;
      if (!best || score > best.score) best = { idx, score };
    }
  }
  if (!best) return null;
  // Put the run in loop order (a backward match was collected in reverse).
  const idx = best.idx;
  const forward = idx.length < 2 || idx[1] === (idx[0] + 1) % n;
  const ordered = forward ? idx : [...idx].reverse();
  const segs = ordered.map((i) => loop[i]);
  return { segs, lines: segs.map((s) => s.line) };
}

/** True if a line name was generated by an edit (cut / merge / smooth). */
export function isGeneratedLine(name: string): boolean {
  return GENERATED.has(lineKind(name));
}

// ── Weighted least-squares cubic fit ──────────────────────────────────────────

function segLength(b: Bezier, n = 64): number {
  let L = 0;
  let prev = b[0];
  for (let k = 1; k <= n; k++) {
    const q = bezierAt(b, k / n);
    L += Math.hypot(q.x - prev.x, q.y - prev.y);
    prev = q;
  }
  return L;
}

const bern = (u: number): [number, number, number, number] => {
  const m = 1 - u;
  return [m * m * m, 3 * m * m * u, 3 * m * u * u, u * u * u];
};

/** First and second derivative of a cubic Bézier at u. */
function derivs(b: Bezier, u: number): [Vec2, Vec2] {
  const m = 1 - u;
  const d1 = {
    x: 3 * (m * m * (b[1].x - b[0].x) + 2 * m * u * (b[2].x - b[1].x) + u * u * (b[3].x - b[2].x)),
    y: 3 * (m * m * (b[1].y - b[0].y) + 2 * m * u * (b[2].y - b[1].y) + u * u * (b[3].y - b[2].y)),
  };
  const d2 = {
    x: 6 * (m * (b[2].x - 2 * b[1].x + b[0].x) + u * (b[3].x - 2 * b[2].x + b[1].x)),
    y: 6 * (m * (b[2].y - 2 * b[1].y + b[0].y) + u * (b[3].y - 2 * b[2].y + b[1].y)),
  };
  return [d1, d2];
}

/**
 * Fit one cubic Bézier to a chain of segments (oriented head→tail, end-to-end).
 * End points are kept; control points minimise the length-weighted squared
 * distance to points sampled along the chain.
 */
export function fitCubicToChain(segs: BoundarySeg[]): Bezier {
  const P0 = segs[0].bezier[0];
  const P3 = segs[segs.length - 1].bezier[3];
  const lens = segs.map((s) => segLength(s.bezier));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const straight = (): Bezier => [
    P0,
    { x: P0.x + (P3.x - P0.x) / 3, y: P0.y + (P3.y - P0.y) / 3 },
    { x: P0.x + (2 * (P3.x - P0.x)) / 3, y: P0.y + (2 * (P3.y - P0.y)) / 3 },
    P3,
  ];

  // Samples evenly spaced along each segment (≈ 300 over the whole chain), with
  // their arc-length position (→ initial parameter) and weight.
  const Q: Vec2[] = [];
  const s: number[] = [];
  const w: number[] = [];
  let acc = 0;
  segs.forEach((seg, i) => {
    const m = Math.max(4, Math.ceil((lens[i] / total) * 300));
    for (let k = 0; k < m; k++) {
      Q.push(bezierAt(seg.bezier, k / m));
      s.push(acc + (lens[i] * k) / m);
      // weight ∝ line length; × spacing so the result doesn't depend on m
      w.push(lens[i] * (lens[i] / m));
    }
    acc += lens[i];
  });
  Q.push(P3); s.push(total); w.push(lens[lens.length - 1] * (lens[lens.length - 1] / 4));
  const u = s.map((v) => v / total);

  let fit = straight();
  // Alternate solve / reparameterize until the parameters settle (convergence
  // is linear; ~80 passes reach ≈ 0.005 mm on an exactly-cubic chain).
  for (let iter = 0; iter < 150; iter++) {
    // Normal equations for P1, P2 (shared 2×2 matrix, x and y right-hand sides).
    let a11 = 0, a12 = 0, a22 = 0, bx1 = 0, bx2 = 0, by1 = 0, by2 = 0;
    for (let k = 0; k < Q.length; k++) {
      const [b0, b1, b2, b3] = bern(u[k]);
      const rx = Q[k].x - b0 * P0.x - b3 * P3.x;
      const ry = Q[k].y - b0 * P0.y - b3 * P3.y;
      a11 += w[k] * b1 * b1; a12 += w[k] * b1 * b2; a22 += w[k] * b2 * b2;
      bx1 += w[k] * b1 * rx; bx2 += w[k] * b2 * rx;
      by1 += w[k] * b1 * ry; by2 += w[k] * b2 * ry;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12 * (a11 * a22 || 1)) return straight();
    fit = [
      P0,
      { x: (a22 * bx1 - a12 * bx2) / det, y: (a22 * by1 - a12 * by2) / det },
      { x: (a11 * bx2 - a12 * bx1) / det, y: (a11 * by2 - a12 * by1) / det },
      P3,
    ];
    // Reparameterize: one Newton step per sample towards its nearest curve point.
    let maxStep = 0;
    for (let k = 1; k < Q.length - 1; k++) {
      const p = bezierAt(fit, u[k]);
      const [d1, d2] = derivs(fit, u[k]);
      const dx = p.x - Q[k].x, dy = p.y - Q[k].y;
      const num = dx * d1.x + dy * d1.y;
      const den = d1.x * d1.x + d1.y * d1.y + dx * d2.x + dy * d2.y;
      if (Math.abs(den) > 1e-12) {
        const nu = Math.min(1, Math.max(0, u[k] - num / den));
        maxStep = Math.max(maxStep, Math.abs(nu - u[k]));
        u[k] = nu;
      }
    }
    if (maxStep < 1e-7) break;
  }
  return fit;
}

// ── Applying a smoothing to a piece ───────────────────────────────────────────

function bboxOfPaths(paths: Record<string, string>): GeometryResult["bbox"] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of Object.values(paths)) {
    const v = (d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    for (let i = 0; i + 1 < v.length; i += 2) {
      minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]);
      minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1]);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Replace the selected consecutive outline lines of a piece by one fitted
 * cubic. Every other line (incl. aux lines) and point is kept, except points
 * sitting on the run's inner joints (they'd float off the new curve). The new
 * line is a seam named "smooth" (or "smooth#2", …) and inherits the line spec
 * of the longest replaced line. Returns null if the lines aren't a valid run.
 */
export function smoothGeometry(g: GeometryResult, lines: string[]): GeometryResult | null {
  // Matched by line kind and order (not exact names, not lengths), so the
  // smoothing still applies after a resize renames or lengthens short lines.
  const run = resolveStoredRun(g, lines);
  if (!run) return null;
  const curve = fitCubicToChain(run.segs);

  let name = SMOOTH_LINE;
  for (let i = 2; name in g.paths && !run.lines.includes(name); i++) name = `${SMOOTH_LINE}#${i}`;

  const paths: Record<string, string> = {};
  const lineTypes: Record<string, string | undefined> = {};
  for (const [k, d] of Object.entries(g.paths)) {
    if (run.lines.includes(k)) continue;
    paths[k] = d;
    lineTypes[k] = g.lineTypes[k];
  }
  paths[name] = bezierToPath(curve);
  lineTypes[name] = "seam";

  const lineSpecs: Record<string, LineSpec> = { ...g.lineSpecs };
  let longest = run.segs[0];
  for (const sg of run.segs) if (segLength(sg.bezier) > segLength(longest.bezier)) longest = sg;
  const inherited = g.lineSpecs?.[longest.line];
  for (const l of run.lines) delete lineSpecs[l];
  if (inherited) lineSpecs[name] = inherited;

  // Drop points on the inner joints of the run.
  const joints = run.segs.slice(1).map((sg) => sg.bezier[0]);
  const eps = 1e-6;
  const points: GeometryResult["points"] = {};
  for (const [k, p] of Object.entries(g.points)) {
    if (joints.some((j) => Math.hypot(j.x - p.x, j.y - p.y) <= eps)) continue;
    points[k] = p;
  }

  return { ...g, points, paths, lineTypes, lineSpecs, bbox: boundsWithCircles(bboxOfPaths(paths), g.circles) };
}
