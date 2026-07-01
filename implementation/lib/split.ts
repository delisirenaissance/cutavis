// Geometry core for the "split a part along a line" edit.
//
// A pattern part's outline is the set of its seam/hem lines (each a cubic
// Bézier). For darted parts these lines form a *branching* graph, not a simple
// polygon (dart legs spur inward, creating degree-3 vertices — see the back
// skirt part). To find the cut-able outline we therefore extract the OUTER
// boundary: the face of the planar subdivision that encloses everything, which
// naturally ignores interior dart spurs and bridges.
//
// This module holds only pure geometry helpers (no React, no measurement
// engine). Coordinates come in already-resolved via a GeometryResult, so the
// same functions work at cut-time (screen) and replay-time (after measurement
// changes).

import { intersectBeziers } from "./geometry";
import type { GeometryResult, ResolvedPoint } from "./geometry";

export type Vec2 = { x: number; y: number };
export type Bezier = [Vec2, Vec2, Vec2, Vec2];

// ── Bézier primitives ───────────────────────────────────────────────────────

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Split a cubic Bézier at an arbitrary t ∈ [0,1] into its two halves
 *  (de Casteljau). Generalises geometry.ts's t=0.5 splitBezier. */
export function splitBezierAt(b: Bezier, t: number): [Bezier, Bezier] {
  const p01 = lerp(b[0], b[1], t);
  const p12 = lerp(b[1], b[2], t);
  const p23 = lerp(b[2], b[3], t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return [
    [b[0], p01, p012, p0123],
    [p0123, p123, p23, b[3]],
  ];
}

/** Reverse a Bézier's direction (swap endpoints and controls). */
export function reverseBezier(b: Bezier): Bezier {
  return [b[3], b[2], b[1], b[0]];
}

/** Evaluate a cubic Bézier at parameter t ∈ [0,1]. */
export function bezierAt(b: Bezier, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const c1 = 3 * mt * mt * t;
  const c2 = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * b[0].x + c1 * b[1].x + c2 * b[2].x + d * b[3].x,
    y: a * b[0].y + c1 * b[1].y + c2 * b[2].y + d * b[3].y,
  };
}

/** Parse an "M x y C x y x y x y" path (the only form geometry.ts emits) into a
 *  cubic Bézier. Returns null if the string doesn't hold at least 4 points. */
export function parsePathBezier(d: string): Bezier | null {
  const nums = d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!nums || nums.length < 8) return null;
  const f = nums.slice(0, 8).map(Number);
  return [
    { x: f[0], y: f[1] },
    { x: f[2], y: f[3] },
    { x: f[4], y: f[5] },
    { x: f[6], y: f[7] },
  ];
}

// ── Boundary segments ─────────────────────────────────────────────────────────

/** One outline segment: the source line name plus its resolved Bézier. */
export interface BoundarySeg {
  line: string;
  bezier: Bezier;
}

/** Extract the seam/hem segments of a resolved part geometry (aux lines and
 *  hidden conditional lines are already absent from `paths`). */
export function boundarySegments(g: GeometryResult): BoundarySeg[] {
  const out: BoundarySeg[] = [];
  for (const [line, d] of Object.entries(g.paths)) {
    const lt = g.lineTypes[line];
    if (lt !== "seam" && lt !== "hem") continue;
    const b = parsePathBezier(d);
    if (b) out.push({ line, bezier: b });
  }
  return out;
}

// ── Outer-boundary extraction (planar outer-face walk) ──────────────────────

/** Ordered outline: each entry oriented head→tail along the traced loop. */
export interface OuterBoundary {
  ok: boolean;
  /** When !ok, a short human reason for the disabled scissors tooltip. */
  reason?: string;
  loop: BoundarySeg[];
}

interface HalfEdge {
  from: number; // vertex index
  to: number;
  seg: BoundarySeg; // oriented from→to
  ang: number; // outgoing tangent angle at `from`
  twin: HalfEdge;
}

/** Outgoing tangent angle at the start of a Bézier (falls back through the
 *  control points for the degenerate straight [A,A,B,B] form). */
function startAngle(b: Bezier, eps: number): number {
  for (const q of [b[1], b[2], b[3]]) {
    const dx = q.x - b[0].x;
    const dy = q.y - b[0].y;
    if (Math.hypot(dx, dy) > eps) return Math.atan2(dy, dx);
  }
  return 0;
}

/**
 * Extract the outer boundary loop from a set of seam/hem segments.
 *
 * Approach: cluster endpoints into vertices, build a doubly-linked set of
 * directed half-edges sorted by angle around each vertex, then trace faces.
 * The outer boundary is the traced face with the largest enclosed area; a
 * near-zero area means the outline is open (a tree/spur, no enclosed region).
 */
export function extractOuterBoundary(segs: BoundarySeg[]): OuterBoundary {
  if (segs.length < 3) {
    return { ok: false, reason: "outline needs at least 3 seam/hem lines", loop: [] };
  }

  // Scale-relative tolerance for endpoint clustering. Shared endpoints resolve
  // to identical coordinates, so this only merges true coincidences.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs)
    for (const p of s.bezier) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const eps = diag * 1e-6;

  // Cluster endpoints into vertices.
  const verts: Vec2[] = [];
  const findVert = (p: Vec2): number => {
    for (let i = 0; i < verts.length; i++) {
      if (Math.hypot(verts[i].x - p.x, verts[i].y - p.y) <= eps) return i;
    }
    verts.push({ x: p.x, y: p.y });
    return verts.length - 1;
  };
  const edges = segs.map((s) => ({ seg: s, a: findVert(s.bezier[0]), b: findVert(s.bezier[3]) }));

  // Drop fully-duplicate edges (same endpoints AND same controls) — e.g. the
  // skirt part's doubled 8→9 line — which would otherwise be parallel edges.
  const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= eps;
  const kept: typeof edges = [];
  for (const e of edges) {
    const dup = kept.some((k) => {
      const fwd = k.a === e.a && k.b === e.b &&
        near(k.seg.bezier[1], e.seg.bezier[1]) && near(k.seg.bezier[2], e.seg.bezier[2]);
      const rev = k.a === e.b && k.b === e.a &&
        near(k.seg.bezier[1], e.seg.bezier[2]) && near(k.seg.bezier[2], e.seg.bezier[1]);
      return fwd || rev;
    });
    if (!dup) kept.push(e);
  }

  // Build half-edges and group them (angle-sorted) around each vertex.
  const outByV: HalfEdge[][] = verts.map(() => []);
  for (const e of kept) {
    const fb = e.seg.bezier;
    const rb = reverseBezier(fb);
    const fwd: HalfEdge = {
      from: e.a, to: e.b, seg: e.seg, ang: startAngle(fb, eps),
      twin: undefined as unknown as HalfEdge,
    };
    const bwd: HalfEdge = {
      from: e.b, to: e.a, seg: { line: e.seg.line, bezier: rb }, ang: startAngle(rb, eps),
      twin: fwd,
    };
    fwd.twin = bwd;
    outByV[e.a].push(fwd);
    outByV[e.b].push(bwd);
  }
  for (const arr of outByV) arr.sort((p, q) => p.ang - q.ang);

  // Face traversal: arriving via `he` into vertex `he.to`, the next edge of the
  // face is the one just clockwise of the twin in the angular order.
  const nextInFace = (he: HalfEdge): HalfEdge => {
    const arr = outByV[he.to];
    const i = arr.indexOf(he.twin);
    return arr[(i - 1 + arr.length) % arr.length];
  };

  const traceFace = (start: HalfEdge): HalfEdge[] | null => {
    const loop: HalfEdge[] = [];
    let he = start;
    let guard = 0;
    do {
      loop.push(he);
      he = nextInFace(he);
      if (++guard > 100000) return null;
    } while (he !== start);
    return loop;
  };

  // Signed area of a traced face using its chord (endpoint) polygon.
  const faceArea = (loop: HalfEdge[]): number => {
    let s = 0;
    for (const he of loop) {
      const p = verts[he.from];
      const q = verts[he.to];
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  };

  // Seed at an extreme vertex (min y, then min x) — guaranteed on the outer
  // face. Trace the face through each of its out-edges and keep the largest
  // (by |area|): the outer boundary encloses everything.
  let seed = 0;
  for (let i = 1; i < verts.length; i++) {
    if (verts[i].y < verts[seed].y ||
        (verts[i].y === verts[seed].y && verts[i].x < verts[seed].x)) {
      seed = i;
    }
  }

  let best: HalfEdge[] | null = null;
  let bestArea = 0;
  for (const he of outByV[seed]) {
    const loop = traceFace(he);
    if (!loop) continue;
    const a = Math.abs(faceArea(loop));
    if (a > bestArea) { bestArea = a; best = loop; }
  }

  if (!best || bestArea <= eps * eps) {
    return { ok: false, reason: "seam/hem lines don't enclose a closed area", loop: [] };
  }

  return { ok: true, loop: best.map((he) => he.seg) };
}

// ── Snapping a click onto the outline ─────────────────────────────────────────

/** Where a screen point lands on the outline: which loop segment, the Bézier
 *  parameter t there, the coordinates, and the distance from the click. */
export interface Snap {
  segIndex: number;
  t: number;
  point: Vec2;
  dist: number;
  line: string;
}

/** Nearest point on the outer boundary to `p` (for snap-to-boundary picking).
 *  Samples each segment's Bézier uniformly in t; ~200 samples/segment is ample
 *  for pointer feedback. Returns null for an empty loop. */
export function snapToBoundary(loop: BoundarySeg[], p: Vec2, samples = 200): Snap | null {
  let best: Snap | null = null;
  for (let i = 0; i < loop.length; i++) {
    const b = loop[i].bezier;
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      const q = bezierAt(b, t);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.dist) {
        best = { segIndex: i, t, point: q, dist: d, line: loop[i].line };
      }
    }
  }
  return best;
}

// ── Partitioning the loop into two pieces along the cut ───────────────────────

/** A cut endpoint anchored to a loop segment at Bézier parameter t. */
export interface CutAnchor {
  segIndex: number;
  t: number;
}

/** Optional curvature of the cut, expressed relative to the straight chord from
 *  the first to the second cut point, so it scales when measurements change.
 *  Each control is [alongFraction, perpFraction]: `along` is the fraction of the
 *  chord vector, `perp` is the fraction of the chord length perpendicular to it
 *  (90° CCW). A straight cut is `undefined`. */
export interface CutBow {
  c1: [number, number];
  c2: [number, number];
}

/** Result of partitioning: two closed sub-loops plus the cut curve used. */
export interface SplitPieces {
  ok: boolean;
  reason?: string;
  /** The arc running forward along the loop from the earlier to the later
   *  anchor, closed by the cut. */
  inner: BoundarySeg[];
  /** The wrap-around arc, closed by the cut (reversed). */
  outer: BoundarySeg[];
  /** The cut curve, oriented from the earlier anchor to the later one. */
  cut: Bezier;
}

/** Build the cut Bézier between two points, optionally bowed (chord-relative). */
export function buildCutBezier(pA: Vec2, pB: Vec2, bow?: CutBow): Bezier {
  if (!bow) return [pA, { ...pA }, { ...pB }, pB]; // canonical straight [A,A,B,B]
  const vx = pB.x - pA.x;
  const vy = pB.y - pA.y;
  const len = Math.hypot(vx, vy) || 1;
  const nx = -vy / len; // unit perpendicular (90° CCW), scaled by len below
  const ny = vx / len;
  const ctrl = ([along, perp]: [number, number]): Vec2 => ({
    x: pA.x + along * vx + perp * len * nx,
    y: pA.y + along * vy + perp * len * ny,
  });
  return [pA, ctrl(bow.c1), ctrl(bow.c2), pB];
}

/**
 * Split the outline loop into two closed sub-loops along a cut between two
 * boundary anchors. Whole segments go to exactly one side; the two anchored
 * segments are split at their t and their fragments distributed. The cut curve
 * closes both sides (forward on one, reversed on the other), so each returned
 * piece is a closed contour.
 */
export function partitionLoop(
  loop: BoundarySeg[],
  a0: CutAnchor,
  b0: CutAnchor,
  bow?: CutBow
): SplitPieces {
  const empty = { inner: [], outer: [], cut: [] as unknown as Bezier };
  const n = loop.length;
  if (n < 2) return { ok: false, reason: "outline too small to cut", ...empty };

  // Tolerance from the loop's overall size.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of loop)
    for (const p of s.bezier) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const eps = diag * 1e-6;

  // Order the two anchors along the loop (earlier = A).
  let a = a0, b = b0;
  const earlier = (x: CutAnchor, y: CutAnchor) =>
    x.segIndex < y.segIndex || (x.segIndex === y.segIndex && x.t < y.t);
  if (!earlier(a, b)) { const t = a; a = b; b = t; }

  const pA = bezierAt(loop[a.segIndex].bezier, a.t);
  const pB = bezierAt(loop[b.segIndex].bezier, b.t);
  if (Math.hypot(pA.x - pB.x, pA.y - pB.y) < eps * 10) {
    return { ok: false, reason: "cut endpoints are too close together", ...empty };
  }

  // Collect the two arcs as oriented (name, bezier) fragments, dropping any
  // zero-length pieces created by snapping onto an existing vertex.
  const named = (line: string, bez: Bezier): BoundarySeg[] =>
    Math.hypot(bez[3].x - bez[0].x, bez[3].y - bez[0].y) < eps ? [] : [{ line, bezier: bez }];
  const whole = (from: number, to: number): BoundarySeg[] => {
    const out: BoundarySeg[] = [];
    for (let i = from; i < to; i++) out.push(loop[i]);
    return out;
  };

  let inner: BoundarySeg[];
  let outer: BoundarySeg[];

  if (a.segIndex === b.segIndex) {
    // Both anchors on one segment → split it into left / mid / right.
    const seg = loop[a.segIndex];
    const [left, restRight] = splitBezierAt(seg.bezier, a.t);
    const t2 = (b.t - a.t) / (1 - a.t); // b's parameter within the remaining piece
    const [mid, right] = splitBezierAt(restRight, t2);
    inner = named(`${seg.line}~m`, mid); // A → B (small arc)
    outer = [
      ...named(`${seg.line}~r`, right), // B → seg end
      ...whole(a.segIndex + 1, n),
      ...whole(0, a.segIndex),
      ...named(`${seg.line}~l`, left), // seg start → A
    ];
  } else {
    const segA = loop[a.segIndex];
    const segB = loop[b.segIndex];
    const [aLeft, aRight] = splitBezierAt(segA.bezier, a.t);
    const [bLeft, bRight] = splitBezierAt(segB.bezier, b.t);
    inner = [
      ...named(`${segA.line}~r`, aRight), // A → segA end
      ...whole(a.segIndex + 1, b.segIndex),
      ...named(`${segB.line}~l`, bLeft), // segB start → B
    ];
    outer = [
      ...named(`${segB.line}~r`, bRight), // B → segB end
      ...whole(b.segIndex + 1, n),
      ...whole(0, a.segIndex),
      ...named(`${segA.line}~l`, aLeft), // segA start → A
    ];
  }

  const cut = buildCutBezier(pA, pB, bow);
  // Close each side with the cut: inner runs A→B then B→A (reversed cut);
  // outer runs B→A then A→B (forward cut).
  inner.push({ line: "cut", bezier: reverseBezier(cut) });
  outer.push({ line: "cut", bezier: cut });

  if (inner.length < 2 || outer.length < 2) {
    return { ok: false, reason: "cut does not divide the outline", ...empty };
  }

  // Reject cuts that don't create two real pieces — e.g. a straight cut between
  // two points on the same straight edge lies along the outline (zero area).
  // Sampled area handles curved edges and bowed cuts (which chord area misses).
  const minArea = diag * diag * 1e-4;
  if (pieceArea(inner) < minArea || pieceArea(outer) < minArea) {
    return { ok: false, reason: "cut must divide the part into two areas", ...empty };
  }
  return { ok: true, inner, outer, cut };
}

/** Absolute polygon area of a closed piece, sampling each Bézier so curved
 *  edges and bowed cuts contribute correctly. */
export function pieceArea(piece: BoundarySeg[], perSeg = 16): number {
  const pts: Vec2[] = [];
  for (const s of piece) {
    for (let k = 0; k < perSeg; k++) pts.push(bezierAt(s.bezier, k / perSeg));
  }
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum / 2);
}

/** A sampled centroid of a piece — used to give the two halves stable A/B
 *  identity that survives measurement changes (independent of loop rotation). */
function pieceCentroid(piece: BoundarySeg[], perSeg = 8): Vec2 {
  let sx = 0, sy = 0, n = 0;
  for (const s of piece) {
    for (let k = 0; k < perSeg; k++) {
      const p = bezierAt(s.bezier, k / perSeg);
      sx += p.x; sy += p.y; n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

// ── Building a GeometryResult per cut piece ───────────────────────────────────

/** SVG path "d" string for a Bézier (same "M x y C …" form geometry.ts emits). */
export function bezierToPath(b: Bezier): string {
  return `M ${b[0].x} ${b[0].y} C ${b[1].x} ${b[1].y} ${b[2].x} ${b[2].y} ${b[3].x} ${b[3].y}`;
}

/**
 * Turn one piece's ordered segments into a self-contained GeometryResult that
 * the plot can render like any other part. Original boundary vertices keep
 * their source labels/point-types (matched by coordinate); interior aux points
 * are naturally dropped; the two cut corners are left unlabeled. The cut edge
 * is typed "seam" so it renders as a solid outline.
 */
export function pieceToGeometry(piece: BoundarySeg[], source: GeometryResult): GeometryResult {
  const diag = source.bbox
    ? Math.hypot(source.bbox.maxX - source.bbox.minX, source.bbox.maxY - source.bbox.minY) || 1
    : 1;
  const eps = diag * 1e-6;

  const paths: Record<string, string> = {};
  const lineTypes: Record<string, string | undefined> = {};
  const points: Record<string, ResolvedPoint> = {};

  const findName = (p: Vec2): string | null => {
    for (const [name, sp] of Object.entries(source.points)) {
      if (Math.hypot(sp.x - p.x, sp.y - p.y) <= eps) return name;
    }
    return null;
  };

  // Ensure unique keys: a piece can inherit a "cut" edge from a prior split and
  // gain a new "cut" from this one — without disambiguation the second would
  // overwrite the first in `paths` and break the outline.
  const uniqueName = (name: string): string => {
    if (!(name in paths)) return name;
    let i = 2;
    while (`${name}#${i}` in paths) i++;
    return `${name}#${i}`;
  };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of piece) {
    const key = uniqueName(seg.line);
    paths[key] = bezierToPath(seg.bezier);
    if (seg.line === "cut") {
      lineTypes[key] = "seam";
    } else {
      const base = seg.line.split("~")[0];
      lineTypes[key] = source.lineTypes[base] ?? "seam";
    }
    for (const end of [seg.bezier[0], seg.bezier[3]]) {
      const name = findName(end);
      if (name && !(name in points)) {
        points[name] = { ...source.points[name], x: end.x, y: end.y };
      }
    }
    for (const p of seg.bezier) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }

  return {
    points,
    paths,
    lineTypes,
    localValues: {},
    bbox: piece.length ? { minX, minY, maxX, maxY } : null,
    errors: {},
  };
}

// ── Planar-arrangement cut (handles cutting through darts → ≥2 pieces) ────────
// The two-anchor `partitionLoop` above assumes the cut crosses the outline
// exactly twice. When the cut also crosses interior edges (e.g. both legs of a
// dart), it must split there too, which can yield three or more pieces. This is
// done by intersecting the cut with EVERY outline edge, keeping the cut
// sub-segments that lie inside the material, and extracting all faces of the
// resulting planar arrangement.

/** Nearest Bézier parameter t to a point (exported for anchor storage: the cut
 *  endpoints are stored as a parameter along the line's *definition* direction). */
export function nearestParamOnBezier(b: Bezier, p: Vec2, samples = 400): number {
  return paramOnBezier(b, p, samples);
}

/** Nearest Bézier parameter t to a point (used to locate an intersection along
 *  an edge and along the cut). */
function paramOnBezier(b: Bezier, p: Vec2, samples = 400): number {
  let bestT = 0, bestD = Infinity;
  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    const q = bezierAt(b, t);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  return bestT;
}

/** The portion of a Bézier between parameters s1 < s2. */
function subBezier(b: Bezier, s1: number, s2: number): Bezier {
  if (s1 <= 0 && s2 >= 1) return b;
  const [, right] = splitBezierAt(b, s1);
  const t2 = s1 >= 1 ? 0 : (s2 - s1) / (1 - s1);
  const [left] = splitBezierAt(right, Math.max(0, Math.min(1, t2)));
  return left;
}

/** Even-odd point-in-polygon over a piecewise-Bézier outline (sampled). */
function pointInPolygon(loop: BoundarySeg[], p: Vec2, perSeg = 16): boolean {
  const pts: Vec2[] = [];
  for (const s of loop) for (let k = 0; k < perSeg; k++) pts.push(bezierAt(s.bezier, k / perSeg));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Chord signed area of a face (its Bézier segments' endpoints). */
function faceSignedArea(face: BoundarySeg[]): number {
  let s = 0;
  for (const sg of face) {
    const p = sg.bezier[0], q = sg.bezier[3];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** Extract every face of a planar arrangement of Bézier edges. Each face is a
 *  cyclic list of segments oriented head→tail. Reuses the angle-sorted
 *  half-edge / next-in-face machinery from extractOuterBoundary, but walks all
 *  faces rather than just the outer one. */
function buildArrangementFaces(edges: BoundarySeg[], eps: number): BoundarySeg[][] {
  const verts: Vec2[] = [];
  const findV = (p: Vec2): number => {
    for (let i = 0; i < verts.length; i++) {
      if (Math.hypot(verts[i].x - p.x, verts[i].y - p.y) <= eps) return i;
    }
    verts.push({ x: p.x, y: p.y });
    return verts.length - 1;
  };

  interface HE { from: number; to: number; seg: BoundarySeg; ang: number; twin: HE; visited: boolean }
  const outByV: HE[][] = [];
  const ensure = (i: number) => { while (outByV.length <= i) outByV.push([]); };
  const halves: HE[] = [];
  for (const e of edges) {
    const a = findV(e.bezier[0]);
    const b = findV(e.bezier[3]);
    if (a === b) continue; // drop zero-length
    ensure(a); ensure(b);
    const rb = reverseBezier(e.bezier);
    const fwd: HE = { from: a, to: b, seg: e, ang: startAngle(e.bezier, eps), twin: undefined as unknown as HE, visited: false };
    const bwd: HE = { from: b, to: a, seg: { line: e.line, bezier: rb }, ang: startAngle(rb, eps), twin: fwd, visited: false };
    fwd.twin = bwd;
    halves.push(fwd, bwd);
    outByV[a].push(fwd);
    outByV[b].push(bwd);
  }
  for (const arr of outByV) arr.sort((p, q) => p.ang - q.ang);

  const nextInFace = (he: HE): HE => {
    const arr = outByV[he.to];
    const i = arr.indexOf(he.twin);
    return arr[(i - 1 + arr.length) % arr.length];
  };

  const faces: BoundarySeg[][] = [];
  for (const start of halves) {
    if (start.visited) continue;
    const loop: HE[] = [];
    let he = start;
    let guard = 0;
    do {
      he.visited = true;
      loop.push(he);
      he = nextInFace(he);
      if (++guard > 100000) break;
    } while (he !== start);
    faces.push(loop.map((x) => x.seg));
  }
  return faces;
}

/** Result of a planar-arrangement cut. */
export interface ArrangeResult {
  ok: boolean;
  reason?: string;
  /** Every material piece the cut produced (2 or more). */
  pieces: BoundarySeg[][];
}

/**
 * Cut an outline polygon with a curve, intersecting EVERY edge it crosses (so
 * dart legs are severed too) and returning all resulting material pieces.
 */
export function arrangeCut(
  loop: BoundarySeg[],
  a: CutAnchor,
  b: CutAnchor,
  bow?: CutBow
): ArrangeResult {
  if (loop.length < 2) return { ok: false, reason: "outline too small to cut", pieces: [] };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of loop)
    for (const p of s.bezier) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const eps = diag * 1e-6;
  const minArea = diag * diag * 1e-4;

  const pA = bezierAt(loop[a.segIndex].bezier, a.t);
  const pB = bezierAt(loop[b.segIndex].bezier, b.t);
  if (Math.hypot(pA.x - pB.x, pA.y - pB.y) < eps * 10) {
    return { ok: false, reason: "cut endpoints are too close together", pieces: [] };
  }

  const cut = buildCutBezier(pA, pB, bow);

  // All crossings of the cut with the outline edges (dart legs included), each
  // located by parameter on its edge (tE) and along the cut (sC).
  interface Cross { point: Vec2; edge: number; tE: number; sC: number }
  const crossings: Cross[] = [];
  for (let i = 0; i < loop.length; i++) {
    for (const h of intersectBeziers(cut, loop[i].bezier, eps)) {
      crossings.push({ point: h, edge: i, tE: paramOnBezier(loop[i].bezier, h), sC: paramOnBezier(cut, h) });
    }
  }
  // The two placed endpoints are crossings by construction — add them explicitly
  // in case the subdivision missed the exact endpoints.
  crossings.push({ point: pA, edge: a.segIndex, tE: a.t, sC: 0 });
  crossings.push({ point: pB, edge: b.segIndex, tE: b.t, sC: 1 });
  // De-duplicate coincident crossings on the same edge.
  const uniq: Cross[] = [];
  for (const c of crossings) {
    if (!uniq.some((u) => u.edge === c.edge && Math.hypot(u.point.x - c.point.x, u.point.y - c.point.y) <= eps * 5)) {
      uniq.push(c);
    }
  }

  // Crossing coordinates from intersectBeziers and split points from
  // paramOnBezier are independent approximations of the same point, differing
  // by more than the clustering tolerance. To keep the arrangement graph
  // connected we force every fragment/cut endpoint at a crossing to the SAME
  // canonical coordinate (the intersection hit).
  const withStart = (b: Bezier, p: Vec2): Bezier => [{ ...p }, b[1], b[2], b[3]];
  const withEnd = (b: Bezier, p: Vec2): Bezier => [b[0], b[1], b[2], { ...p }];

  // Cut sub-segments between consecutive crossings, keeping only those inside
  // the material (segments spanning a dart notch lie outside and are dropped).
  const alongCut = [...uniq].sort((p, q) => p.sC - q.sC);
  const cutEdges: BoundarySeg[] = [];
  for (let k = 0; k < alongCut.length - 1; k++) {
    const c1 = alongCut[k], c2 = alongCut[k + 1];
    if (c2.sC - c1.sC < 1e-6) continue;
    const sub = withStart(withEnd(subBezier(cut, c1.sC, c2.sC), c2.point), c1.point);
    if (pointInPolygon(loop, bezierAt(sub, 0.5))) cutEdges.push({ line: "cut", bezier: sub });
  }
  if (cutEdges.length === 0) {
    return { ok: false, reason: "cut does not cross the part interior", pieces: [] };
  }

  // Split each outline edge at its crossings into fragments, forcing each split
  // point to the canonical crossing coordinate so it matches the cut endpoints.
  const fragments: BoundarySeg[] = [];
  for (let i = 0; i < loop.length; i++) {
    const cs = uniq
      .filter((u) => u.edge === i && u.tE > 1e-6 && u.tE < 1 - 1e-6)
      .sort((x, y) => x.tE - y.tE);
    let remaining = loop[i].bezier;
    let lastT = 0;
    for (const c of cs) {
      const localT = (c.tE - lastT) / (1 - lastT);
      const [left, right] = splitBezierAt(remaining, localT);
      fragments.push({ line: loop[i].line, bezier: withEnd(left, c.point) });
      remaining = withStart(right, c.point);
      lastT = c.tE;
    }
    fragments.push({ line: loop[i].line, bezier: remaining });
  }

  // Extract faces. Exactly one face is the unbounded outer region; since the
  // outline dips into any dart notches, that face's |area| equals the whole
  // material area and is therefore the largest — drop it. Every other face
  // above the area threshold is a material piece. (A centroid-in-polygon test
  // would be wrong here: a concave piece's centroid can fall inside a notch.)
  const faces = buildArrangementFaces([...fragments, ...cutEdges], eps);
  if (faces.length === 0) return { ok: false, reason: "cut does not divide the part", pieces: [] };
  const areas = faces.map((f) => Math.abs(faceSignedArea(f)));
  let outerIdx = 0;
  areas.forEach((ar, i) => { if (ar > areas[outerIdx]) outerIdx = i; });

  const pieces = faces.filter((f, i) => i !== outerIdx && areas[i] > minArea);
  if (pieces.length < 2) return { ok: false, reason: "cut must divide the part into pieces", pieces: [] };
  return { ok: true, pieces };
}

/** A cut endpoint anchored to a boundary line by name plus the parameter t
 *  along that line's DEFINITION direction (its path / linePointReferences
 *  order). The definition direction is measurement-independent, unlike the
 *  outer-boundary walk which may traverse an edge either way — so storing t
 *  this way keeps the cut endpoint stable across measurement changes. */
export interface SplitAnchor {
  line: string;
  t: number;
}

/**
 * Apply a split to a resolved geometry: re-extract its outer boundary, locate
 * the two anchor lines by name, run the planar-arrangement cut, and build a
 * GeometryResult for each resulting piece. Pieces are tagged with stable
 * "A","B","C"… suffixes ordered by centroid (left-to-right, then top-to-bottom)
 * so a given physical piece keeps its id across measurement changes. Returns
 * null when the split can't be applied (outline not closed, anchor line gone,
 * degenerate cut) so the caller can leave the piece intact.
 */
export function splitGeometry(
  g: GeometryResult,
  from: SplitAnchor,
  to: SplitAnchor,
  bow?: CutBow
): { suffix: string; geometry: GeometryResult }[] | null {
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return null;

  // Resolve each anchor: its stored t is along the line's DEFINITION direction,
  // so turn it into a point via the definition Bézier, then re-locate that point
  // on the (possibly reversed) loop edge. This is what makes the cut stable when
  // the outer-boundary walk flips an edge's traversal between measurements.
  const resolve = (anchor: SplitAnchor): CutAnchor | null => {
    const iLoop = ob.loop.findIndex((s) => s.line === anchor.line);
    if (iLoop < 0) return null;
    const def = parsePathBezier(g.paths[anchor.line]);
    if (!def) return null;
    const point = bezierAt(def, anchor.t);
    return { segIndex: iLoop, t: paramOnBezier(ob.loop[iLoop].bezier, point) };
  };
  const a = resolve(from);
  const b = resolve(to);
  if (!a || !b) return null;

  const res = arrangeCut(ob.loop, a, b, bow);
  if (!res.ok) return null;

  const eps = (g.bbox ? Math.hypot(g.bbox.maxX - g.bbox.minX, g.bbox.maxY - g.bbox.minY) || 1 : 1) * 1e-3;
  const built = res.pieces.map((pc) => ({ geometry: pieceToGeometry(pc, g), c: pieceCentroid(pc) }));
  built.sort((p, q) => (Math.abs(p.c.x - q.c.x) <= eps ? p.c.y - q.c.y : p.c.x - q.c.x));
  return built.map((b, i) => ({ suffix: String.fromCharCode(65 + i), geometry: b.geometry }));
}

/** Resolve a boundary anchor (line + definition-relative t) to a coordinate on
 *  the current geometry. Used e.g. as a rotation center. Returns null if the
 *  line is absent. */
export function resolveAnchorPoint(g: GeometryResult, anchor: SplitAnchor): Vec2 | null {
  const def = parsePathBezier(g.paths[anchor.line]);
  return def ? bezierAt(def, anchor.t) : null;
}

// ── Merging two parts along a shared edge ─────────────────────────────────────
// The user picks a line on one part; we find lines on OTHER parts that could be
// sewn to it (nearly parallel, similar length, and whose connecting "bridges"
// don't cross that other part). "Pull together" translates one part so the two
// lines coincide; "merge" removes both lines and stitches the two outlines into
// one polygon.

const straight = (p: Vec2, q: Vec2): Bezier => [{ ...p }, { ...p }, { ...q }, { ...q }];
const dist = (p: Vec2, q: Vec2): number => Math.hypot(p.x - q.x, p.y - q.y);

/** A boundary segment identified by the piece it belongs to. */
export interface MergeSeg {
  pieceId: string;
  line: string;
  bezier: Bezier;
}

interface PieceGeom {
  id: string;
  geometry: GeometryResult;
}

function chordLen(b: Bezier): number {
  return Math.hypot(b[3].x - b[0].x, b[3].y - b[0].y);
}

/** Undirected angle (degrees) between two segments' start→end chords. */
function chordAngleDeg(a: Bezier, b: Bezier): number {
  const ax = a[3].x - a[0].x, ay = a[3].y - a[0].y;
  const bx = b[3].x - b[0].x, by = b[3].y - b[0].y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 180;
  const c = Math.min(1, Math.abs((ax * bx + ay * by) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** True if `seg` crosses any of `others` somewhere other than at seg's own
 *  endpoints (shared vertices are allowed). */
function segCrossesAny(seg: Bezier, others: Bezier[], eps: number): boolean {
  for (const o of others) {
    for (const h of intersectBeziers(seg, o, eps)) {
      if (dist(h, seg[0]) <= eps * 20 || dist(h, seg[3]) <= eps * 20) continue;
      return true;
    }
  }
  return false;
}

function overallDiag(pieces: PieceGeom[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pieces) {
    const b = p.geometry.bbox;
    if (!b) continue;
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  return Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) || 1 : 1;
}

/** Outer-boundary segment of a piece matching a line name (already resolved). */
function loopSeg(g: GeometryResult, line: string): Bezier | null {
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return null;
  const s = ob.loop.find((x) => x.line === line);
  return s ? s.bezier : null;
}

/**
 * Find lines on OTHER pieces suited to merge with the selected line:
 *  A) nearly parallel (chord angle ≤ maxAngleDeg),
 *  B) chord length within ±maxLenPct % of the selected line,
 *  C) the two "bridge" lines (selected endpoints → the candidate's endpoints)
 *     don't cross any other line of the candidate's piece.
 */
export function findMergeCandidates(
  pieces: PieceGeom[],
  selPieceId: string,
  selLine: string,
  maxAngleDeg: number,
  maxLenPct: number
): MergeSeg[] {
  const sel = pieces.find((p) => p.id === selPieceId);
  if (!sel) return [];
  const selBez = loopSeg(sel.geometry, selLine);
  if (!selBez) return [];
  const Ss = selBez[0], Se = selBez[3];
  const selLen = chordLen(selBez);
  if (selLen === 0) return [];
  const eps = overallDiag(pieces) * 1e-6;

  const out: MergeSeg[] = [];
  for (const p of pieces) {
    if (p.id === selPieceId) continue;
    const ob = extractOuterBoundary(boundarySegments(p.geometry));
    if (!ob.ok) continue;
    for (let i = 0; i < ob.loop.length; i++) {
      const cand = ob.loop[i].bezier;
      if (chordAngleDeg(selBez, cand) > maxAngleDeg) continue; // A
      const cl = chordLen(cand);
      if (Math.abs(cl - selLen) / selLen > maxLenPct / 100) continue; // B
      // C: bridges from the selected endpoints to the candidate's endpoints.
      const C1 = cand[0], C2 = cand[3];
      const near = dist(C1, Ss) <= dist(C2, Ss) ? C1 : C2;
      const far = near === C1 ? C2 : C1;
      const Li = straight(Ss, near);
      const Lii = straight(Se, far);
      const others = ob.loop.filter((_, j) => j !== i).map((s) => s.bezier);
      if (segCrossesAny(Li, others, eps) || segCrossesAny(Lii, others, eps)) continue;
      out.push({ pieceId: p.id, line: ob.loop[i].line, bezier: cand });
    }
  }
  return out;
}

/** Translation to move piece B so its line best coincides with A's line
 *  (choosing the direct or reversed endpoint correspondence, whichever fits). */
export function pullTogetherOffset(
  gA: GeometryResult, lineA: string,
  gB: GeometryResult, lineB: string
): { dx: number; dy: number } | null {
  const a = loopSeg(gA, lineA);
  const b = loopSeg(gB, lineB);
  if (!a || !b) return null;
  const As = a[0], Ae = a[3], Bs = b[0], Be = b[3];
  // direct: Bs→As, Be→Ae ; reversed: Bs→Ae, Be→As.
  const avg = (p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2) => ({
    dx: ((p1.x - q1.x) + (p2.x - q2.x)) / 2,
    dy: ((p1.y - q1.y) + (p2.y - q2.y)) / 2,
  });
  const resid = (o: { dx: number; dy: number }, p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2) =>
    (p1.x - q1.x - o.dx) ** 2 + (p1.y - q1.y - o.dy) ** 2 +
    (p2.x - q2.x - o.dx) ** 2 + (p2.y - q2.y - o.dy) ** 2;
  const oDir = avg(As, Bs, Ae, Be);
  const oRev = avg(Ae, Bs, As, Be);
  return resid(oDir, As, Bs, Ae, Be) <= resid(oRev, Ae, Bs, As, Be) ? oDir : oRev;
}

/**
 * Merge two parts along the picked lines: remove both lines and stitch the two
 * outlines into a single polygon, bridging the open ends (nearest-to-nearest).
 * Returns null if either outline/line can't be resolved.
 */
export function mergeGeometryPair(
  gA: GeometryResult, lineA: string,
  gB: GeometryResult, lineB: string
): GeometryResult | null {
  const obA = extractOuterBoundary(boundarySegments(gA));
  const obB = extractOuterBoundary(boundarySegments(gB));
  if (!obA.ok || !obB.ok) return null;
  const kA = obA.loop.findIndex((s) => s.line === lineA);
  const kB = obB.loop.findIndex((s) => s.line === lineB);
  if (kA < 0 || kB < 0) return null;

  const nA = obA.loop.length, nB = obB.loop.length;
  const segA = obA.loop[kA].bezier, segB = obB.loop[kB].bezier;
  const As = segA[0], Ae = segA[3], Bs = segB[0], Be = segB[3];

  // Open chains (each excluding the removed line): chainA runs Ae→As.
  const chainA: BoundarySeg[] = [];
  for (let i = 1; i < nA; i++) chainA.push(obA.loop[(kA + i) % nA]);
  const chainBf: BoundarySeg[] = []; // Be→Bs
  for (let i = 1; i < nB; i++) chainBf.push(obB.loop[(kB + i) % nB]);
  const chainBr: BoundarySeg[] = chainBf
    .slice().reverse().map((s) => ({ line: s.line, bezier: reverseBezier(s.bezier) })); // Bs→Be

  const eps = (Math.hypot(
    (gA.bbox?.maxX ?? 0) - (gA.bbox?.minX ?? 0),
    (gA.bbox?.maxY ?? 0) - (gA.bbox?.minY ?? 0)
  ) || 1) * 1e-5;

  const merged: BoundarySeg[] = [...chainA];
  const bridge = (p: Vec2, q: Vec2) => { if (dist(p, q) > eps) merged.push({ line: "merge", bezier: straight(p, q) }); };

  // Two ways to attach chainB; pick the one with shorter bridges.
  const opt1 = dist(As, Be) + dist(Bs, Ae); // As→Be, chainBf, Bs→Ae
  const opt2 = dist(As, Bs) + dist(Be, Ae); // As→Bs, chainBr, Be→Ae
  if (opt1 <= opt2) {
    bridge(As, Be); merged.push(...chainBf); bridge(Bs, Ae);
  } else {
    bridge(As, Bs); merged.push(...chainBr); bridge(Be, Ae);
  }

  const source: GeometryResult = {
    points: { ...gA.points, ...gB.points },
    paths: { ...gA.paths, ...gB.paths },
    lineTypes: { ...gA.lineTypes, ...gB.lineTypes },
    localValues: {},
    bbox: gA.bbox && gB.bbox
      ? {
          minX: Math.min(gA.bbox.minX, gB.bbox.minX), minY: Math.min(gA.bbox.minY, gB.bbox.minY),
          maxX: Math.max(gA.bbox.maxX, gB.bbox.maxX), maxY: Math.max(gA.bbox.maxY, gB.bbox.maxY),
        }
      : gA.bbox ?? gB.bbox,
    errors: {},
  };
  return pieceToGeometry(merged, source);
}
