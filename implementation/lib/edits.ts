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
import type { AllowanceType, MergeMarker } from "./types";
import { smoothGeometry } from "./smooth";

/** A single, undoable edit applied to one part or (after a split) a sub-piece,
 *  identified by its piece id (`file`, or `file_1`, `file_2`, … after cuts).
 *
 *  `split` cuts one piece into two along a curve between two boundary anchors.
 *  The anchors are stored *parametrically* (boundary line name + parameter t)
 *  and the optional `bow` is chord-relative, so the cut survives measurement
 *  changes rather than floating off the reshaped outline. */
export type PatternEdit =
  | { type: "translate"; part: string; dx: number; dy: number }
  | { type: "split"; part: string; from: SplitAnchor; to: SplitAnchor; bow?: CutBow }
  | { type: "rotate"; part: string; center: SplitAnchor; angle: number }
  | { type: "merge"; partA: string; lineA: string; partB: string; lineB: string }
  /** Specify one line of a piece: its seam-allowance type and optional merge
   *  marker. Later lineSpec edits on the same line override earlier ones. */
  | { type: "lineSpec"; part: string; line: string; allowance: AllowanceType; marker: MergeMarker | null }
  /** Replace ≥ 2 consecutive outline lines of a piece by one fitted cubic
   *  (re-fitted on every replay, so it follows measurement changes). */
  | { type: "smooth"; part: string; lines: string[] };

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
 *  piece with the root id; each split replaces one piece with its N children
 *  `id_1` … `id_N` (so cutting `partA_2` again yields `partA_2_1`, …). A merge
 *  of two pieces yields `idA&idB`. */
export interface PartPiece {
  id: string;
  geometry: GeometryResult;
}

/** Id of the n-th (1-based) child created by cutting piece `parentId`. */
export function childPartId(parentId: string, n: number): string {
  return `${parentId}_${n}`;
}

const DERIVED_SUFFIX_RE = /^\d+(?:_\d+)*$/;

/** True if piece `pieceId` is the part `partId` itself, was derived from it by
 *  cuts (`partId_1`, `partId_2_1`, …), or is a merge involving such a piece.
 *  Part file names may themselves contain "_", so only purely numeric `_n`
 *  suffixes count as derived. */
export function belongsToPart(pieceId: string, partId: string): boolean {
  return pieceId.split("&").some(
    (c) =>
      c === partId ||
      (c.startsWith(partId + "_") && DERIVED_SUFFIX_RE.test(c.slice(partId.length + 1)))
  );
}

/** The loaded part file a (possibly derived) piece id belongs to, e.g.
 *  "skirt_2_1" → "skirt". The longest matching file name wins (for a merged
 *  piece: whichever involved file is longest). Returns null if none matches. */
export function rootPartOf(id: string, loadedFiles: readonly string[]): string | null {
  let best: string | null = null;
  for (const f of loadedFiles) {
    if (belongsToPart(id, f) && (best == null || f.length > best.length)) best = f;
  }
  return best;
}

/** Convert piece ids from the legacy letter scheme (`skirt#A#B`, `a#A&b#B`) to
 *  the numeric one (`skirt_1_2`, `a_1&b_2`). Ids already in the new form pass
 *  through unchanged, so this is safe to run on every load. */
export function migratePieceId(id: string): string {
  return id.replace(/#([A-Z])/g, (_, L: string) => `_${L.charCodeAt(0) - 64}`);
}

/** Migrate a whole edit history to the numeric piece-id scheme. */
export function migrateEdits(edits: PatternEdit[]): PatternEdit[] {
  return edits.map((e) =>
    e.type === "merge"
      ? { ...e, partA: migratePieceId(e.partA), partB: migratePieceId(e.partB) }
      : { ...e, part: migratePieceId(e.part) }
  );
}

/**
 * Global piece-aware replay: apply the whole ordered edit history on top of all
 * loaded parts' base geometries at once, yielding the current set of pieces.
 *
 * Edits are processed in commit order against a shared piece map, so they can
 * interleave and reference pieces produced by earlier edits:
 *  • translate/rotate transform a piece in place,
 *  • split replaces one piece with its N children (`id_1` … `id_N`),
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
      // Never overwrite an unrelated piece that already carries a child's id
      // (e.g. a separately loaded part file literally named "partA_1").
      const ids = halves.map((_, i) => childPartId(e.part, i + 1));
      if (ids.some((id) => pieces.has(id))) continue;
      pieces.delete(e.part);
      halves.forEach((h, i) => pieces.set(ids[i], h.geometry));
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
    } else if (e.type === "smooth") {
      const g = pieces.get(e.part);
      if (!g) continue;
      const sm = smoothGeometry(g, e.lines);
      if (sm) pieces.set(e.part, sm); // lines no longer consecutive/present → skip
    } else if (e.type === "lineSpec") {
      const g = pieces.get(e.part);
      if (!g || !(e.line in g.paths)) continue; // line gone → nothing to specify
      pieces.set(e.part, {
        ...g,
        lineSpecs: { ...g.lineSpecs, [e.line]: { allowance: e.allowance, marker: e.marker } },
      });
    }
  }

  return [...pieces.entries()].map(([id, geometry]) => ({ id, geometry }));
}
