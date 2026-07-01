// Pattern edit model.
//
// A "pattern" is a combination of pattern parts loaded together, plus an ordered
// sequence of edits the user has applied to them. Edits are stored as data (an
// event log), not baked into geometry, so they can be:
//   • replayed on top of freshly-evaluated geometry whenever measurements change,
//   • undone by dropping the last entry and replaying,
//   • serialized into a pattern file and restored later.
//
// This file is the single extension point for new edit kinds. Today only
// "translate" (move a part) exists; a future "split" (cut a part along a line)
// will be added as another variant of PatternEdit and another branch in
// applyEditsToGeometry — the surrounding machinery (history, undo, persistence,
// per-part rendering) does not need to change.

import type { GeometryResult } from "./geometry";
import { splitGeometry, resolveAnchorPoint, mergeGeometryPair, type CutBow, type SplitAnchor } from "./split";

/** A single, undoable edit applied to one part or (after a split) a sub-piece,
 *  identified by its piece id (`file`, or `file#A` / `file#B` after cuts).
 *
 *  `split` cuts one piece into two along a curve between two boundary anchors.
 *  The anchors are stored *parametrically* (boundary line name + parameter t)
 *  and the optional `bow` is chord-relative, so the cut survives measurement
 *  changes rather than floating off the reshaped outline. */
export type PatternEdit =
  | { type: "translate"; part: string; dx: number; dy: number }
  | { type: "split"; part: string; from: SplitAnchor; to: SplitAnchor; bow?: CutBow }
  | { type: "rotate"; part: string; center: SplitAnchor; angle: number }
  | { type: "merge"; partA: string; lineA: string; partB: string; lineB: string };

/** On-disk pattern format. `parts` lists the part files to load together;
 *  `edits` is the ordered history applied to them. */
export interface PatternFile {
  version: 1;
  parts: string[];
  edits: PatternEdit[];
}

export function buildPattern(parts: string[], edits: PatternEdit[]): PatternFile {
  return { version: 1, parts, edits };
}

/** Stable string used to detect unsaved changes to the current pattern. */
export function patternSignature(parts: string[], edits: PatternEdit[]): string {
  return JSON.stringify(buildPattern(parts, edits));
}

// ── Applying edits to resolved geometry ────────────────────────────────────────

/** Shift every coordinate in an SVG path "d" string by (dx, dy). Our paths are
 *  built solely from absolute M/C commands ("M x y C x y x y x y"), so the
 *  numbers alternate x, y, x, y… across the whole string. */
function shiftPathData(d: string, dx: number, dy: number): string {
  let i = 0;
  return d.replace(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g, (tok) => {
    const v = parseFloat(tok);
    const out = i % 2 === 0 ? v + dx : v + dy;
    i++;
    return String(out);
  });
}

function translateGeometry(g: GeometryResult, dx: number, dy: number): GeometryResult {
  const points: GeometryResult["points"] = {};
  for (const [k, p] of Object.entries(g.points)) {
    points[k] = { ...p, x: p.x + dx, y: p.y + dy };
  }
  const paths: GeometryResult["paths"] = {};
  for (const [k, d] of Object.entries(g.paths)) {
    paths[k] = shiftPathData(d, dx, dy);
  }
  const bbox = g.bbox
    ? {
        minX: g.bbox.minX + dx,
        minY: g.bbox.minY + dy,
        maxX: g.bbox.maxX + dx,
        maxY: g.bbox.maxY + dy,
      }
    : null;
  return { ...g, points, paths, bbox };
}

const NUM_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

/** Rotate every (x, y) coordinate pair in a path "d" string about (cx, cy). */
function rotatePathData(d: string, cx: number, cy: number, cos: number, sin: number): string {
  const vals = (d.match(NUM_RE) ?? []).map(Number);
  const out = vals.slice();
  for (let i = 0; i + 1 < vals.length; i += 2) {
    const x = vals[i] - cx;
    const y = vals[i + 1] - cy;
    out[i] = cx + x * cos - y * sin;
    out[i + 1] = cy + x * sin + y * cos;
  }
  let i = 0;
  return d.replace(NUM_RE, () => String(out[i++]));
}

/** Rotate a whole geometry about (cx, cy) by `angle` radians (matches the SVG
 *  `rotate(deg cx cy)` used for the live preview). */
function rotateGeometry(g: GeometryResult, cx: number, cy: number, angle: number): GeometryResult {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const points: GeometryResult["points"] = {};
  for (const [k, p] of Object.entries(g.points)) {
    const x = p.x - cx;
    const y = p.y - cy;
    points[k] = { ...p, x: cx + x * cos - y * sin, y: cy + x * sin + y * cos };
  }
  const paths: GeometryResult["paths"] = {};
  for (const [k, d] of Object.entries(g.paths)) paths[k] = rotatePathData(d, cx, cy, cos, sin);

  // Rotation is not axis-aligned, so recompute the bbox from the rotated coords.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const d of Object.values(paths)) {
    const vals = (d.match(NUM_RE) ?? []).map(Number);
    for (let i = 0; i + 1 < vals.length; i += 2) {
      any = true;
      minX = Math.min(minX, vals[i]); maxX = Math.max(maxX, vals[i]);
      minY = Math.min(minY, vals[i + 1]); maxY = Math.max(maxY, vals[i + 1]);
    }
  }
  return { ...g, points, paths, bbox: any ? { minX, minY, maxX, maxY } : g.bbox };
}

/**
 * Replay an edit sequence on top of a part's freshly-evaluated geometry.
 * `edits` should already be filtered to the part in question (callers pass the
 * subset whose `part` matches). Unknown edit types are ignored so older/newer
 * pattern files degrade gracefully.
 *
 * Note: this collapses translations into one net offset; it does NOT handle
 * splits (which turn one part into several pieces). Use `applyEditsToPart` for
 * the piece-aware replay.
 */
export function applyEditsToGeometry(
  geometry: GeometryResult,
  edits: PatternEdit[]
): GeometryResult {
  // Translations compose into a single net offset.
  let dx = 0;
  let dy = 0;
  for (const e of edits) {
    if (e.type === "translate") {
      dx += e.dx;
      dy += e.dy;
    }
  }
  return dx === 0 && dy === 0 ? geometry : translateGeometry(geometry, dx, dy);
}

/** One renderable piece of a loaded part. Before any split there is a single
 *  piece with the root id; each split replaces one piece with two (`id#A`,
 *  `id#B`). */
export interface PartPiece {
  id: string;
  geometry: GeometryResult;
}

/** The root part id a (possibly split) piece id belongs to, e.g.
 *  "skirt#A#B" → "skirt". */
export function rootPartOf(id: string): string {
  const i = id.indexOf("#");
  return i < 0 ? id : id.slice(0, i);
}

/**
 * Global piece-aware replay: apply the whole ordered edit history on top of all
 * loaded parts' base geometries at once, yielding the current set of pieces.
 *
 * Edits are processed in commit order against a shared piece map, so they can
 * interleave and reference pieces produced by earlier edits:
 *  • translate/rotate transform a piece in place,
 *  • split replaces one piece with two (`id#A`, `id#B`),
 *  • merge combines two pieces into one (`idA&idB`).
 * An edit whose target piece(s) are missing, or that can't be applied to the
 * current geometry, is skipped (graceful degradation, like unknown edit types).
 */
export function applyPatternEdits(bases: PartPiece[], edits: PatternEdit[]): PartPiece[] {
  const pieces = new Map<string, GeometryResult>();
  for (const b of bases) pieces.set(b.id, b.geometry);

  for (const e of edits) {
    if (e.type === "translate") {
      const g = pieces.get(e.part);
      if (g) pieces.set(e.part, translateGeometry(g, e.dx, e.dy));
    } else if (e.type === "split") {
      const g = pieces.get(e.part);
      if (!g) continue;
      const halves = splitGeometry(g, e.from, e.to, e.bow);
      if (!halves) continue; // leave the piece intact if the cut can't apply
      pieces.delete(e.part);
      for (const h of halves) pieces.set(`${e.part}#${h.suffix}`, h.geometry);
    } else if (e.type === "rotate") {
      const g = pieces.get(e.part);
      if (!g) continue;
      const c = resolveAnchorPoint(g, e.center);
      if (!c) continue; // center line gone → leave the piece unrotated
      pieces.set(e.part, rotateGeometry(g, c.x, c.y, e.angle));
    } else if (e.type === "merge") {
      const gA = pieces.get(e.partA);
      const gB = pieces.get(e.partB);
      if (!gA || !gB) continue;
      const merged = mergeGeometryPair(gA, e.lineA, gB, e.lineB);
      if (!merged) continue;
      pieces.delete(e.partA);
      pieces.delete(e.partB);
      pieces.set(`${e.partA}&${e.partB}`, merged);
    }
  }

  return [...pieces.entries()].map(([id, geometry]) => ({ id, geometry }));
}
