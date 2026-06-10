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

/** A single, undoable edit applied to one loaded part (identified by its file id). */
export type PatternEdit =
  | { type: "translate"; part: string; dx: number; dy: number };
// Future variants, e.g.:
//   | { type: "split"; part: string; line: string; keep: "left" | "right" }

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

/**
 * Replay an edit sequence on top of a part's freshly-evaluated geometry.
 * `edits` should already be filtered to the part in question (callers pass the
 * subset whose `part` matches). Unknown edit types are ignored so older/newer
 * pattern files degrade gracefully.
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
