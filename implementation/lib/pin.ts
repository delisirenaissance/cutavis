// Pinning a part (e.g. a button hole) to the part it lies on (its "host").
//
// A pin stores where the pinned part sits relative to the host: an anchor on
// the host's outline nearest to the pinned part (line + t along the line's
// definition direction — measurement-stable, like cut anchors) and the offset
// from that anchor to the pinned part's reference point (its bbox centre).
// On replay the pinned part is re-placed from that anchor, so it follows the
// host when measurements reshape it; and while pinned, moves/rotations of
// either part are applied to the whole combination (see lib/edits.ts).

import type { GeometryResult } from "./geometry";
import {
  bezierAt,
  boundarySegments,
  extractOuterBoundary,
  nearestParamOnBezier,
  parsePathBezier,
  snapToBoundary,
  type SplitAnchor,
  type Vec2,
} from "./split";

/** Reference point of a part: the centre of its bounding box. */
export function refPoint(g: GeometryResult): Vec2 | null {
  const b = g.bbox;
  return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null;
}

/** Anchor + offset describing where `child` sits relative to `host`. The
 *  anchor is null if the host has no closed outline (the pin then only links
 *  the parts, without re-placing the child on replay). */
export function pinPlacement(
  child: GeometryResult, host: GeometryResult
): { anchor: SplitAnchor | null; offset: { x: number; y: number } } {
  const ref = refPoint(child);
  const ob = extractOuterBoundary(boundarySegments(host));
  if (!ref || !ob.ok) return { anchor: null, offset: { x: 0, y: 0 } };
  const snap = snapToBoundary(ob.loop, ref);
  const def = snap ? parsePathBezier(host.paths[snap.line]) : null;
  if (!snap || !def) return { anchor: null, offset: { x: 0, y: 0 } };
  const t = nearestParamOnBezier(def, snap.point);
  const a = bezierAt(def, t);
  return { anchor: { line: snap.line, t }, offset: { x: ref.x - a.x, y: ref.y - a.y } };
}

/** The shift that puts `child`'s reference point back at anchor + offset on
 *  the CURRENT host geometry; null if the anchor line is gone. */
export function pinDelta(
  child: GeometryResult, host: GeometryResult, anchor: SplitAnchor, offset: { x: number; y: number }
): { dx: number; dy: number } | null {
  const ref = refPoint(child);
  const def = parsePathBezier(host.paths[anchor.line]);
  if (!ref || !def) return null;
  const a = bezierAt(def, anchor.t);
  return { dx: a.x + offset.x - ref.x, dy: a.y + offset.y - ref.y };
}

/** True if point p lies inside the part's outer outline. */
export function partContains(g: GeometryResult, p: Vec2): boolean {
  const ob = extractOuterBoundary(boundarySegments(g));
  if (!ob.ok) return false;
  const pts: Vec2[] = [];
  for (const s of ob.loop) for (let k = 0; k < 16; k++) pts.push(bezierAt(s.bezier, k / 16));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
