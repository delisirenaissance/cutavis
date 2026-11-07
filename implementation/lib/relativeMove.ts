// Relative moves: a translate edit can be anchored to the nearest other part,
// so the moved part keeps its position RELATIVE to that part when parts change
// size (measurement changes) — e.g. two lines pulled together for merging stay
// together after a resize.
//
// Anchor: the middle (t = 0.5) of a line of the moved part (`lineA`), and the
// nearest point on a line of the other part (`lineB`, at `tB`), both as t along
// each line's definition direction (measurement-stable, like cut anchors),
// plus the gap vector B→A at the end of the move. Replay places the moved part
// so its anchor point lands at the other part's anchor point + gap.

import type { GeometryResult } from "./geometry";
import {
  bezierAt,
  boundarySegments,
  extractOuterBoundary,
  nearestParamOnBezier,
  parsePathBezier,
  type Bezier,
  type Vec2,
} from "./split";

export interface RelativeMove {
  /** The part the move is anchored to. */
  other: string;
  /** Anchor line + parameter on the moved part (definition direction). */
  lineA: string;
  tA: number;
  /** Anchor line + parameter on the other part. */
  lineB: string;
  tB: number;
  /** Vector from the other part's anchor to the moved part's anchor, at the
   *  end of the move (the remaining gap between the lines). */
  gap: { x: number; y: number };
}

interface PieceLike {
  id: string;
  geometry: GeometryResult;
}

const shiftB = (b: Bezier, dx: number, dy: number): Bezier =>
  b.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Bezier;

/** Outer-outline lines of a piece as definition-direction Béziers. */
function outlineLines(g: GeometryResult): { line: string; bezier: Bezier }[] {
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return [];
  const out: { line: string; bezier: Bezier }[] = [];
  for (const s of ob.loop) {
    const b = parsePathBezier(g.paths[s.line]);
    if (b) out.push({ line: s.line, bezier: b });
  }
  return out;
}

function sample(b: Bezier, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let k = 0; k <= n; k++) pts.push(bezierAt(b, k / n));
  return pts;
}

/** Distance from p to a polyline. */
function distToPolyline(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const vx = b.x - a.x, vy = b.y - a.y;
    const L2 = vx * vx + vy * vy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)));
  }
  return best;
}

/** Build the anchor for a given line pair, with the moved part shifted by
 *  (dx, dy). Null if a line can't be resolved. */
export function relativeMoveForLines(
  moved: GeometryResult, lineA: string,
  other: PieceLike, lineB: string,
  dx: number, dy: number
): RelativeMove | null {
  const bA = parsePathBezier(moved.paths[lineA]);
  const bB = parsePathBezier(other.geometry.paths[lineB]);
  if (!bA || !bB) return null;
  const A = bezierAt(shiftB(bA, dx, dy), 0.5);
  const tB = nearestParamOnBezier(bB, A);
  const B = bezierAt(bB, tB);
  return { other: other.id, lineA, tA: 0.5, lineB, tB, gap: { x: A.x - B.x, y: A.y - B.y } };
}

/**
 * After moving piece `movedId` by (dx, dy): find the closest pair of outline
 * lines between it and any OTHER piece (smallest mean distance of samples
 * along the moved line), and anchor the move to it. Null if there is no other
 * piece with a closed outline.
 */
export function relativeMoveAfterDrag(
  pieces: PieceLike[], movedId: string, dx: number, dy: number
): RelativeMove | null {
  const moved = pieces.find((p) => p.id === movedId);
  if (!moved) return null;
  const myLines = outlineLines(moved.geometry).map((l) => ({
    line: l.line,
    pts: sample(shiftB(l.bezier, dx, dy), 8),
  }));
  if (myLines.length === 0) return null;

  let best: { lineA: string; other: PieceLike; lineB: string; score: number } | null = null;
  for (const o of pieces) {
    if (o.id === movedId) continue;
    for (const ol of outlineLines(o.geometry)) {
      const poly = sample(ol.bezier, 32);
      for (const ml of myLines) {
        let s = 0;
        for (const p of ml.pts) s += distToPolyline(p, poly);
        const score = s / ml.pts.length;
        if (!best || score < best.score) best = { lineA: ml.line, other: o, lineB: ol.line, score };
      }
    }
  }
  return best ? relativeMoveForLines(moved.geometry, best.lineA, best.other, best.lineB, dx, dy) : null;
}

/**
 * Replay: the translation that puts the moved part's anchor at the other
 * part's anchor + gap, given both parts' CURRENT geometry (moved part before
 * this move). Null if a line is gone (→ caller uses the absolute dx/dy).
 */
export function resolveRelativeMove(
  moved: GeometryResult, other: GeometryResult, rel: RelativeMove
): { dx: number; dy: number } | null {
  const bA = parsePathBezier(moved.paths[rel.lineA]);
  const bB = parsePathBezier(other.paths[rel.lineB]);
  if (!bA || !bB) return null;
  const A = bezierAt(bA, rel.tA);
  const B = bezierAt(bB, rel.tB);
  return { dx: B.x + rel.gap.x - A.x, dy: B.y + rel.gap.y - A.y };
}
