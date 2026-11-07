// Seam allowance: a closed polygon at a per-line distance OUTSIDE a part.
//
// Each segment of the part's outer outline is offset outward by the allowance
// of its line (see ALLOWANCE_MM; default "seam" = 10 mm). The offset segments
// are joined at the corners:
//   • convex corner  → mitred (both offset tangents extended until they meet),
//                       falling back to a straight bevel for very sharp corners;
//   • concave corner → connected directly; the two offsets cross each other,
//                       forming a small reversed loop that is removed below.
// Dart notches behave like two concave corners and are trimmed the same way.
// Finally every self-intersection loop whose orientation is opposite to the
// outline's is cut away, leaving one clean closed polygon.
//
// Coordinates are pattern units (cm), so 10 mm = 1.0.

import type { GeometryResult } from "./geometry";
import { ALLOWANCE_MM, DEFAULT_LINE_SPEC } from "./types";
import { bezierAt, boundarySegments, extractOuterBoundary, type Bezier, type Vec2 } from "./split";

/** Allowance distance (cm) of a line of a piece. */
export function allowanceCm(g: GeometryResult, line: string): number {
  const spec = g.lineSpecs?.[line] ?? DEFAULT_LINE_SPEC;
  return ALLOWANCE_MM[spec.allowance] / 10;
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2) => Math.hypot(v.x, v.y);
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;

function signedArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** A straight Bézier (both controls on the chord) needs only its endpoints. */
function isStraight(b: Bezier): boolean {
  const ch = sub(b[3], b[0]);
  const L = len(ch);
  if (L === 0) return true;
  return (
    Math.abs(cross(ch, sub(b[1], b[0]))) / L < 1e-6 * L &&
    Math.abs(cross(ch, sub(b[2], b[0]))) / L < 1e-6 * L
  );
}

function sampleBezier(b: Bezier, n = 32): Vec2[] {
  if (isStraight(b)) return [b[0], b[3]];
  const pts: Vec2[] = [];
  for (let k = 0; k <= n; k++) pts.push(bezierAt(b, k / n));
  return pts;
}

/** Intersection of segments ab and cd strictly inside both (not at ends). */
function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-14) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  const e = 1e-9;
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** First pair of non-adjacent crossing edges of a closed polygon. */
function firstCrossing(P: Vec2[]): { i: number; j: number; x: Vec2 } | null {
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // closing edge is adjacent to edge 0
      const c = P[j], d = P[(j + 1) % n];
      if (Math.max(c.x, d.x) < minX || Math.min(c.x, d.x) > maxX) continue;
      if (Math.max(c.y, d.y) < minY || Math.min(c.y, d.y) > maxY) continue;
      const x = segIntersect(a, b, c, d);
      if (x) return { i, j, x };
    }
  }
  return null;
}

/** Remove self-intersection loops, keeping the part oriented like `sign`. */
function removeLoops(pts: Vec2[], sign: number): Vec2[] {
  let P = pts;
  for (let guard = 0; guard < 1000; guard++) {
    const hit = firstCrossing(P);
    if (!hit) break;
    const { i, j, x } = hit;
    const inner = [x, ...P.slice(i + 1, j + 1)];
    const outer = [x, ...P.slice(j + 1), ...P.slice(0, i + 1)];
    const aIn = signedArea(inner);
    const aOut = signedArea(outer);
    const okIn = Math.sign(aIn) === sign;
    const okOut = Math.sign(aOut) === sign;
    // Keep the correctly oriented loop; if both (or neither) are, the larger.
    const keepInner = okIn !== okOut ? okIn : Math.abs(aIn) > Math.abs(aOut);
    P = keepInner ? inner : outer;
    if (P.length < 3) return [];
  }
  return P;
}

/** Max angle between the two legs at a concave vertex for it to count as a
 *  dart tip (typical darts are 10–30°). */
const DART_MAX_DEG = 40;

/**
 * Darts are sewn closed, so the allowance must run ACROSS a dart opening, not
 * into the notch (offsetting the legs would pinch the allowance to almost
 * nothing at the dart mouth). Each dart tip — a concave vertex whose two legs
 * are less than DART_MAX_DEG apart — has its two legs replaced by one straight
 * segment across the dart mouth, with the larger allowance of the neighbouring
 * lines.
 */
function bridgeDarts(segs: { bezier: Bezier; d: number }[], sign: number): { bezier: Bezier; d: number }[] {
  const n = segs.length;
  const unitV = (v: Vec2) => { const L = len(v); return L > 0 ? { x: v.x / L, y: v.y / L } : v; };
  const endTan = (b: Bezier) => unitV(sub(b[3], bezierAt(b, 0.99)));
  const startTan = (b: Bezier) => unitV(sub(bezierAt(b, 0.01), b[0]));
  const cosMax = Math.cos((DART_MAX_DEG * Math.PI) / 180);
  // isTip[i]: the vertex at the END of segment i is a dart tip.
  const isTip = segs.map((s, i) => {
    const tA = endTan(s.bezier);
    const tB = startTan(segs[(i + 1) % n].bezier);
    const concave = sign * cross(tA, tB) < 0;
    const legsClose = -(tA.x * tB.x + tA.y * tB.y) > cosMax; // angle(−tA, tB) small
    return concave && legsClose;
  });
  if (!isTip.some(Boolean) || n < 4) return segs;

  // Start the walk right after a non-tip vertex so no dart straddles the wrap.
  const start = (isTip.findIndex((t) => !t) + 1) % n;
  const order = Array.from({ length: n }, (_, k) => (start + k) % n);
  const out: { bezier: Bezier; d: number }[] = [];
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (isTip[i] && k + 1 < n) {
      const legIn = segs[i];
      const legOut = segs[order[k + 1]];
      const prev = segs[(i - 1 + n) % n];
      const next = segs[(order[k + 1] + 1) % n];
      const a = legIn.bezier[0];
      const b = legOut.bezier[3];
      out.push({ bezier: [a, a, b, b], d: Math.max(prev.d, next.d) });
      k++; // both legs consumed
    } else {
      out.push(segs[i]);
    }
  }
  return out;
}

/**
 * The seam-allowance polygon of a piece (closed; first point not repeated),
 * or null if the piece has no closed outline.
 */
export function seamAllowanceOutline(g: GeometryResult): Vec2[] | null {
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return null;

  const raw = ob.loop
    .map((s) => ({ bezier: s.bezier, d: allowanceCm(g, s.line) }))
    .filter((s) => len(sub(s.bezier[3], s.bezier[0])) > 1e-9 || !isStraight(s.bezier));
  if (raw.length < 2) return null;

  // Orientation of the outline decides which side is "outside".
  const area = signedArea(raw.flatMap((s) => sampleBezier(s.bezier).slice(0, -1)));
  if (Math.abs(area) < 1e-9) return null;
  const sign = Math.sign(area);

  const segs = bridgeDarts(raw, sign).map(({ bezier, d }) => ({ pts: sampleBezier(bezier), d }));
  if (segs.length < 2) return null;
  // Outward unit normal for a unit tangent t: right of t for a positively
  // oriented loop (interior on the left), left of t otherwise.
  const outward = (t: Vec2): Vec2 => (sign > 0 ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x });
  const unit = (v: Vec2): Vec2 => {
    const L = len(v);
    return L > 0 ? { x: v.x / L, y: v.y / L } : { x: 0, y: 0 };
  };

  // Offset each segment's samples along their own normals.
  const offs = segs.map(({ pts, d }) => {
    const n = pts.length;
    const tang = pts.map((_, k) => unit(sub(pts[Math.min(n - 1, k + 1)], pts[Math.max(0, k - 1)])));
    const q = pts.map((p, k) => {
      const o = outward(tang[k]);
      return { x: p.x + d * o.x, y: p.y + d * o.y };
    });
    return { q, d, tStart: tang[0], tEnd: tang[n - 1], end: pts[n - 1] };
  });

  const out: Vec2[] = [];
  for (let i = 0; i < offs.length; i++) {
    const A = offs[i];
    const B = offs[(i + 1) % offs.length];
    out.push(...A.q);
    const E = A.q[A.q.length - 1];
    const S = B.q[0];
    const cr = cross(A.tEnd, B.tStart);
    if (Math.abs(cr) < 1e-6 || sign * cr < 0) continue; // smooth or concave: connect directly
    // Convex corner: mitre — E + a·tA = S + b·tB.
    const den = cross(A.tEnd, B.tStart);
    const w = sub(S, E);
    const a = cross(w, B.tStart) / den;
    const b = cross(w, A.tEnd) / den;
    if (a < 0 || b > 0) continue;
    const M = { x: E.x + a * A.tEnd.x, y: E.y + a * A.tEnd.y };
    const limit = 4 * Math.max(A.d, B.d);
    if (len(sub(M, A.end)) <= limit) out.push(M);
  }

  // Drop consecutive near-duplicates (shared sample points at joins).
  const clean: Vec2[] = [];
  for (const p of out) {
    const last = clean[clean.length - 1];
    if (!last || len(sub(p, last)) > 1e-7) clean.push(p);
  }
  if (clean.length > 1 && len(sub(clean[0], clean[clean.length - 1])) <= 1e-7) clean.pop();

  const res = removeLoops(clean, sign);
  return res.length >= 3 ? res : null;
}
