# cutavis — notes for Claude

Sewing patterns defined as formulas. Points are formulas over body measurements;
lines are cubic Béziers between named points. Parts are combined into a pattern
and edited (move / rotate / cut / merge) via a replayable edit history.
Next.js 14 + TypeScript, `expr-eval` for formulas. Run with `npm run dev`.
Type-check with `npx tsc --noEmit`. Don't run `next build` while `next dev` is
running (they share `.next` and it corrupts; restart `npm run dev` to recover).

## Data model

- **Part definition** `patternpartdefinitions/<name>.json` (`lib/types.ts`
  `PartDef`): `part_specific_user_definable_variables`, `local_variables`,
  `points` (`x`/`y` formulas or `"x&y": "f:intersectLines(...)"`), and `lines`.
  Each line has `linePointReferences: [start, c1, c2, end]` (a straight line is
  `[A,A,B,B]`), `lineType` = `seam` | `hem` | `aux`, and an optional `condition`
  that hides the line when false.
- **Evaluation** `evaluatePart(part, measurements)` in `lib/geometry.ts` →
  `GeometryResult { points, paths (SVG "M x y C …" keyed by line name),
  lineTypes, localValues, bbox, errors }`. After this, there are no formulas.
- **Pattern** `patterndefinitions/<name>.json` = `{ version:1, parts:[fileIds],
  edits:[PatternEdit…] }`. API: `/api/patterns`, `/api/patterns/[name]`,
  `/api/parts`, `/api/parts/[name]`.
- **Variables**: measurement sets (`lib/measurementSets.ts`) + body-form values
  (`lib/bodyformVariables.ts`) + each part's own user variables. Page scope for a
  part = `{...measurements, ...bodyformValues, ...part_specific}`.

## Edit model (`lib/edits.ts`, the single extension point)

`PatternEdit` = `translate{part,dx,dy}` | `rotate{part,center:SplitAnchor,angle(rad)}`
| `split{part,from:SplitAnchor,to:SplitAnchor,bow?:CutBow}` |
`merge{partA,lineA,partB,lineB}` | `lineSpec{part,line,allowance,marker}` |
`smooth{part,lines[]}`.

- **Smooth** (`lib/smooth.ts`):
  - `findSmoothRun` orders the picked lines along the outer outline and
    requires ONE consecutive run (it may wrap around the loop start), at least
    2 lines and not the whole loop.
  - Gaps made only of short lines (each ≤ `SMOOTH_SKIP_MAX_CM` = 1 cm, e.g.
    merge bridges) between picked lines are filled automatically. Short lines
    beyond the run ends are not added. If every gap is short, the longest one
    stays open so the loop never closes.
  - The committed edit stores the FULL run (incl. auto-filled lines), so the
    replay doesn't depend on the 1 cm rule. The overlay highlights the
    auto-included lines, and the toolbar text counts them.
  - **Replay matches by line kind + order, not exact names**
    (`resolveStoredRun`, used by `smoothGeometry`):
    - Why: generated names (`merge`, `merge#2`, `cut#3`, and fragment
      duplicates `L12#2`) are assigned in outline-walk order and get RESHUFFLED
      when geometry changes. Seen in basicSkirt.json: the stored `merge` later
      named a bridge on the other edge, and the smoothing was silently skipped.
    - How: kind = name without `#n` / `~…`. The stored sequence is searched
      as a consecutive run in either direction, and the candidate with the
      most exact names wins. A stored `merge` may be missing (bridge vanished
      because its gap closed). Lengths are ignored.
    - The interactive picker (`findSmoothRun`, with the 1 cm gap filling) is
      unchanged.
  - Same fragility elsewhere: other edits that reference generated line names
    (merge lineA/lineB, lineSpec, cut/rotate anchors on derived pieces) can
    still hit the wrong line after a resize.
  - `fitCubicToChain` keeps the run's end points and fits P1/P2 by **weighted**
    least squares. Samples are evenly spaced along the chain, and each sample
    is weighted by the length of its line, so a line's influence ∝ length².
    Long lines are followed closely; short jags (e.g. merge bridges) are
    absorbed.
  - The fit alternates solve and Newton reparameterization, up to 150 passes
    with early exit. Fewer passes left ≈ 0.7 mm error on an exact cubic; now
    it is ≈ 0.0003 mm in < 10 ms.
  - `smoothGeometry` replaces the run in place: it keeps all other lines (incl.
    aux) and points, drops points on the run's inner joints, and adds a seam
    line `smooth` (`smooth#2`, …) that inherits the line spec of the longest
    replaced line. It is re-fitted on every replay; if the lines are no longer
    a valid run, the edit is skipped.
  - UI "〰 Smooth" (`smooth` state): reuses the merge overlay's segment picker
    (`smoothOverlaySegs`). Clicking toggles lines; a line of another piece
    starts a new selection. An orange live preview of the fitted curve is
    shown; "Smooth now" commits.
  - The fit does not force tangent continuity with the neighbouring lines
    (corners at the run ends stay).
- **Piece names** (`rename{part,name}` edit):
  - `applyPatternEdits` keeps a `names` map and returns `PartPiece.name`; use
    `pieceLabel(p)` for "name or id". An empty or blank name removes the name.
  - Cut children inherit `"<name> (n)"`. A merge gets `"<A> + <B>"` (ids for
    unnamed sides) when either side is named.
  - Shown as a label at the piece's bbox centre: on the plot (bold name, or the
    id in muted grey) and in the PDF (14 pt name with the 6.5 pt id under it,
    or a 10 pt id). The PDF overview lists them on the map and in "Parts:".
    The Pattern-tab lists show "id — name".
  - UI: "🏷 Name" in the edit toolbar for the selected piece opens an inline
    field (`naming` state, part of `toolBusy`); Enter saves, Esc cancels.
  - PDF text uses Latin-1/WinAnsi: umlauts and ß are fine; characters outside
    Latin-1 print as "?".
- **Define part → new part** (`definePart{part,def,measures,at,name?}` edit;
  `lib/definePart.ts`, overlay `components/DefineLayer.tsx`):
  - Measure sub-mode: measure along the outline of ANY piece. The start snaps
    to any outline; the end follows that piece's outline. The distance is shown
    at the cursor; you can type a value + Enter; Esc cancels. Each
    measurement is named `d_1`, `d_2`, … (purple diamond + label).
    - **Absolute**: `{kind:"absolute", value}`.
    - **Relative**: `{kind:"relative", part, from, to: SplitAnchor, long?, value}`
      with t along the lines' definition direction. `measureRelative`
      re-measures the arc length between the anchors (shorter way, or longer
      if `long`), so it works even if the outline walk flips direction.
      `value` is the fallback if the piece or its lines are gone.
  - Formula sub-mode: a JSON textarea (part-file format). The default is
    `rectangleTemplate` with `local_variables {width: d_1 | "10", height: d_2 |
    "3"}`. Formulas may use d_n AND pattern variables (body measurements).
  - The live preview uses `evaluateDefinedPart`, the same function as the
    replay. "Save part" creates `defined_<n>` (first free id), placed to the
    right of everything (`placementRightOf`) with its top-left at `at`; an
    optional name goes to the names map.
  - Replay: `applyPatternEdits(bases, edits, vars)`. The page passes
    `variableValues` (re-runs on measurement changes); relative d_n are
    re-measured on the pieces as they are at that point of the history.
    Scope = vars < part_specific vars < d values; unknown names → 0.
  - Defined parts aren't loaded files: `rootPartOf` → null. They aren't listed
    in the Pattern-tab part lists and aren't JSON-editable after saving
    (undo + redefine).
- **Relative moves** (`translate{…, rel?: RelativeMove}`, `lib/relativeMove.ts`):
  - A move stores, besides the absolute `dx/dy`, an anchor pair: the moved
    part's `lineA` at `tA` = 0.5 (middle) and the other part's `lineB` at
    `tB` (nearest point), with t along each line's definition direction, plus
    the `gap` vector B→A at the end of the move.
  - Replay (`resolveRelativeMove`) shifts the part so A lands at B + gap. Lines
    moved next to each other therefore stay together, centred, after resizes.
  - If the other part or a line is gone, it falls back to `dx/dy`. Old
    translate edits without `rel` stay absolute.
  - Drag (`relativeMoveAfterDrag`): picks the outline-line pair (moved part ×
    any other part) with the smallest mean distance after the move.
  - "Pull together" (merge mode, `relativeMoveForLines`): anchors exactly the
    two lines being aligned.
  - Verified: front/back hems pulled together at size 38 stay 0.000 cm apart
    at size 40 (an absolute move drifts 0.75 cm).
- **Delete** (`delete{part}` edit): removes any piece (loaded, cut, merged,
  defined) and its name; later edits on it are skipped; undo restores it.
  UI: "🗑 Delete part" (edit toolbar, selected piece) or the Del/Backspace key
  (ignored while typing in a field or while a tool is active). This differs
  from the ✕ next to the part dropdown (`handleRemovePart`), which unloads a
  whole part FILE plus all its edits and is not undoable.
- page.tsx: one `toolBusy` flag (cut/rotate/merge/specify/smooth/naming/define) gates all
  `can*` flags and toolbar visibility. Add new tools to it.

- **Line specs** (`lib/types.ts`):
  - `LineSpec {lineType, allowance, marker}`. The user picks the **line type**
    (`seam` | `maxi-allowance-hem` | `mini-allowance-hem` | `fold`). The
    **allowance type** is always derived from it with `allowanceTypeOf`:
    fold → `fold-no-allowance`; the others share their name.
  - `ALLOWANCE_MM`: seam 10, maxi 40, mini 7, fold-no-allowance 0 mm. A fold
    edge's allowance outline lies exactly on the fold line.
  - New `lineSpec` edits store `lineType` (+ the derived `allowance`). Older
    edits have only `allowance`, which `lineSpecFromEdit` reads as the line
    type of the same name. The allowance is re-derived on replay, so a fold can
    never carry an allowance.
  - Markers are waistline-, armscye- and neckline-front/back. They are
    informational and NOT printed.
  - Stored on `GeometryResult.lineSpecs[lineName]`; a missing entry means
    `DEFAULT_LINE_SPEC` (seam, no marker).
  - Set by `lineSpec` edits in the history (undoable; a later edit on the same
    line wins). The edits work on pieces, so cut edges and merge seams of
    derived parts can be specified too.
  - `pieceToGeometry` copies a fragment's spec from its source line, so a spec
    set before a cut survives it; new `cut` edges get the default.
    `mergeGeometryPair` unions both parts' specs.
  - These are separate from the part JSON's `lineType` (`seam`/`hem`/`aux`,
    which controls visibility).

- Edits are **stored as data and replayed in geometry space on every render**
  (`applyPatternEdits(bases, edits)`): one ordered pass over ALL edits against a
  shared map from piece id to geometry. Measurement changes therefore reshape
  pieces instead of invalidating them. Undo = drop the last edit.
- An edit whose target piece or line is missing, or whose cut is degenerate, is
  **silently skipped**. `parsePathBezier(undefined)` returns null for exactly
  this case. Before that guard, a rotate about a line the piece lacked threw
  and crashed the render.
- `SplitAnchor {line, t}`: `t` is measured along the line's **definition
  direction** (`parsePathBezier(g.paths[line])`), NOT the outline-walk direction.
  The walk can flip an edge between measurements, so walk-relative t used to
  jump. The UI converts with `nearestParamOnBezier` before storing.
- `CutBow {c1:[along,perp], c2:[along,perp]}` is chord-relative, so it scales
  with the chord.
- Piece ids: split children are named `<parent>_<n>` (n = 1, 2, … ordered by
  centroid, left→right then top→bottom), e.g. `partA_2_1`. A merge produces
  `idA&idB`. Use `belongsToPart(pieceId, partId)` (only numeric `_n` suffixes
  count as derived) and `rootPartOf(id, loadedFiles)` to map a piece back to
  its loaded part file. Part file names may contain `_` themselves, so never
  just split on `_`. If a child id is already taken (e.g. a loaded file named
  `partA_1`), that split is skipped instead of overwriting the other piece.
  Legacy ids (`part#A#B`) are converted by `migrateEdits` when a pattern or
  stored state is loaded.
- Derived parts are NOT JSON files. They are always recomputed from the base
  part plus the history, so they follow measurement changes. The Pattern tab
  lists them under their part (overview: click to highlight; edit mode: click
  to select for move/rotate/cut/merge).

## How a cut defines the resulting polygons (`lib/split.ts`, `splitGeometry`)

1. **Outline**: `boundarySegments` takes only the seam/hem paths →
   `extractOuterBoundary` builds a planar graph (clusters vertices, sorts
   half-edges by angle) and traces the **outer face**. Result: one ordered loop
   that dips into dart notches. Darts are extra seam lines (vertices of degree 3),
   and the outline topology depends on measurements (e.g. back/skirt side seams
   are gated by `condition: "abs(hAbn) < 4.5"`), so the outline is never stitched
   naively.
2. **Anchors** → a point on the line's definition Bézier → re-projected onto that
   line's edge in the loop.
3. **`arrangeCut`** (planar arrangement):
   - Intersect the cut with every loop edge, dart legs included.
   - Keep the cut sub-spans whose midpoint lies inside the material; spans across
     a dart notch are dropped.
   - Split each crossed edge at its crossings. Force both sides to the same
     canonical crossing coordinate; otherwise the graph disconnects and 0 faces
     survive.
   - `buildArrangementFaces` traces all faces; drop the largest |area| face (the
     outside). Every other face above `minArea` is a piece, so a cut through
     darts gives ≥3 pieces.
   - Don't filter faces by centroid-in-polygon: a concave piece's centroid can
     lie in a notch.
4. Pieces are sorted by centroid and named (see piece ids above).
5. **`pieceToGeometry`**: each piece becomes a flat, self-contained
   `GeometryResult`:
   - `paths` holds ONLY the piece's face edges, in face-walk order. Each edge is
     oriented along the walk, not necessarily the original definition direction.
   - Fragments keep the ORIGINAL line name (`L12` can be a different fragment in
     two sibling pieces). Duplicate keys within one piece get `#2`, `#3`.
   - Each inside cut span is its own edge: a piece spanning darts gets `cut`,
     `cut#2`, `cut#3`, numbered in walk order, so these names are fragile as
     anchors. All cut edges are typed `"seam"`.
   - Dropped: aux lines, interior points, formulas, conditions,
     `mergeLineAliasInOtherPartalPattern`. Point labels survive only where a
     source point coincides with a corner; cut corners are unlabeled.
   - Interior dart spurs that are not on the outer outline for the current
     measurements are NOT cut.

Example: the back part of `low_waist_skirt` (sizes 38/40 EU) cut L12→L17 gives 4
pieces:
`_1[L12,L30,L27,cut]`,
`_2[L12,cut,L27,L28,cut#2,L25,L24,cut#3,L17,L18,L19]`,
`_3[L25,cut,L28,L29]`, `_4[L17,cut,L24,L26]`.

## Seam allowance (`lib/allowance.ts`, `seamAllowanceOutline(g)`)

The allowance is a closed polygon (cm) outside the piece's outer outline:
1. Each loop segment gets the allowance of its own line (`allowanceCm`).
2. **Darts are bridged first** (`bridgeDarts`). A concave vertex whose legs
   are < 40° apart is treated as a dart tip, and both legs are replaced by a
   straight line across the dart mouth, using the larger allowance of the two
   neighbouring lines. Without this, the allowance dipped into the notch and
   pinched to about 0.1 cm at the dart mouth.
3. Each segment is sampled (straight lines → 2 points, curves → 33) and
   offset along per-sample normals. The outward side comes from the loop's
   signed area.
4. Corners: convex corners are mitred (miter limit 4·d, otherwise a bevel);
   concave corners are connected directly.
5. `removeLoops` then cuts out self-intersection loops oriented against the
   outline. These come from concave corners and from large allowances next to
   short segments.
6. A change of allowance between smooth neighbouring lines shows as a small
   perpendicular step.

Verified exact on rectangles (both orientations, per-edge 7 mm/10 mm/4 cm), an
L-shape, a dart (bridged) vs. a shallow 90° notch (offset normally), and every
piece of `low_waist_skirt`.

UI: display toggle "Show seam allowance" (`showAllowance`, persisted, default
on). page.tsx computes `allowanceByPiece` → the PatternSvg `allowances` prop,
drawn as a green polygon inside each piece's `<g>` so it follows drags and
rotations. Merge markers appear as purple italic labels at the line midpoint
(screen only).

"✎ Specify line" (edit mode, `specify` state): reuses the merge overlay's
segment picker (`merge` prop with `specifyOverlaySegs`; green = line already
specified). Picking a line prefills the "Line type" and "Merge marker"
dropdowns; "Apply" commits a `lineSpec` edit and stays in the mode; "Done"
leaves it.

## Known fragilities

- **FIXED: browser freeze when merging parts aligned flush**
  (`intersectBeziers`, geometry.ts):
  - Subdividing two COINCIDENT segments yielded ~length/tol "crossings" (about
    1e6), and the O(n²) de-duplication hung.
  - Trigger: `findMergeCandidates` draws bridges to each candidate line's
    ends; once parts touch, a bridge to the far edge runs exactly ALONG the
    other part's edges.
  - Now straight × straight uses exact `intersectSegments`. A collinear overlap
    returns its two ends + midpoint, so `segCrossesAny` (which ignores hits at
    the bridge's own ends) treats "runs along an edge" as crossing. Curves
    keep subdivision with a 256-hit budget.
- **FIXED: random outline direction → jittering pieces.**
  - A closed outline has two faces through the seed vertex (inside and
    outside) with IDENTICAL |area|, traced in opposite directions.
    `extractOuterBoundary` picked with `a > bestArea`, so float rounding decided
    the loop direction, which flipped at isolated measurement values.
  - Merged and smoothed pieces store their lines in loop direction, so `L11`
    etc. were reversed there, and cut anchors (t along the stored path) landed
    mirrored. basicSkirt.json: the front saddle jumped 5.6 → 8.1 cm at TaU
    73.2 / 74.6 / 76.7, and the back saddle 6.8 → 8.6 cm at seven values.
  - Fix: areas are compared with a relative tolerance (1e-9); ties prefer
    POSITIVE orientation, and the chosen loop is normalised to positive (old
    common case → saved edits keep their meaning).
  - Verified: no jumps in any piece over TaU 60–86, HueU 85–115 and HueT 17–24
    in 0.05 steps; old and new differ ONLY at the former spike values.
  - Debug recipe: sweep a measurement, then bisect the edit history between a
    good and a bad value, comparing piece bboxes per edit.
- **Dart topology switch in basicSkirt_backPart** (analysed 2026-11-07):
  - Lines L13–L16 (one dart) exist when `abs(hAbn) < 4.5`; L24–L30 (two
    darts) exist when `abs(hAbn) >= 4.5`.
  - `hAbn = (TaU − HueU − 1)/4 − 1.5·waistform − 0.75·hipbones`, so the part
    has two darts iff `HueU − TaU ≥ 17 − 6·waistform − 3·hipbones` (≥ 8 cm with
    the default body form). The CSV sets 38/40 with every body-form option
    always give two darts; only edited waist/hip values flip it.
  - In one-dart mode the cut gives 3 pieces instead of 4, and _3 is a
    DIFFERENT physical piece. Every edit that names L24–L30 or piece _4 is
    skipped silently: in basicSkirt.json, merges #11/#12 and the smoothings on
    their result.
  - basicSkirt.json mixes both states: #11/#12 merge two-dart legs (L28/L27,
    L25/L24), while #49–#54 redo the merge with one-dart legs (L15/L14). Only
    one of the two groups can ever apply.
  - Fix ideas: make the part topology-stable (always define both darts and let
    the width go to 0 instead of using `condition`), and surface skipped edits
    in the UI instead of skipping them silently.

- Piece numbering depends on the centroid order and the piece count. Both can
  change with measurements or definition edits, and later edits on a piece then
  hit the wrong piece or get skipped.
- Anchors on piece-local names (`cut#2`, a repeated `L12`) are unreliable.
- Pieces carry no provenance beyond line names. Seam allowance on cut edges, or
  mapping a fragment back to its source line, would need per-segment metadata.

## Other edits

- **Rotate**: the center is a `SplitAnchor` (`resolveAnchorPoint`).
  `rotateGeometry` rotates points and path coordinates and recomputes the bbox.
  The live preview uses the same SVG `rotate(deg cx cy)` matrix as the commit.
- **Merge** (`findMergeCandidates`, `pullTogetherOffset`, `mergeGeometryPair`):
  candidate lines on other pieces are found by chord angle ≤ x°, length within
  ±y%, and bridge lines that don't cross the candidate piece. A merge removes
  both lines and stitches the two outlines with straight `merge` bridges. The
  merged piece is plot-only (not in the JSON editor).

## UI (`app/page.tsx`, `components/PatternSvg.tsx`)

- **Two pages, one component** (`view: "shop" | "canvas"`), synced with the
  URL hash `#/pattern/<name>`, so Back returns to the start page and a reload
  stays on the pattern:
  - **Start page** (`components/PatternShop.tsx`): a hero section (half the
    viewport; placeholder "lorem ipsum" / "dolor sit amet..") plus one product
    card per pattern file.
    - Each card has a 2-slide carousel: `patterndesigns/<name>Design.png`, then
      `patternthumbnails/<name>Thumbnail.png`, served by
      `app/api/pattern-images/[kind]/[name]` (404 → placeholder text).
    - The carousel controls don't open the card.
    - `openPattern(name)` re-opens the already loaded pattern without
      reloading (unsaved edits are kept); another pattern asks for confirmation
      if there are unsaved changes, then calls `handleLoadPattern`.
  - **Canvas page**: a header (← All patterns, pattern name, edit count,
    saved/unsaved), a left panel of `Collapsible` sections, and the plot.
    - Left panel: Measurements (collapsed by default, hint = measurement set)
      and Display (collapsed). In edit mode only, "Define pattern" (the former
      Pattern-tab edit content: part dropdown, + Add part, Customize, JSON
      editor, Save, Save pattern), collapsed every time edit mode is entered.
    - Collapse states are not persisted.
  - There is no tab strip or Pattern tab any more; `activeTab` is gone (old
    stored values are ignored). The non-edit part list with highlighting was
    removed together with the Pattern tab.
- Left of the canvas: the `edit-column` = "✎ Edit pattern" / "✓ Done editing"
  toggle, with the collapsible edit-tools bar below it in edit mode.
- **Tailor mode** (`tailorMode`, persisted, default OFF; `TailorSwitch` at the
  top right of both pages):
  - Only when on are the Display section, the whole edit column (and
    therefore edit mode and "Define pattern"), and the Inspector rendered.
    The Inspector always starts collapsed.
  - Switching it off while editing calls `exitPatternEdit`.
- **Phones (≤ 700 px)**, the media block at the END of globals.css (it must
  stay last, because equal-specificity base rules defined later would
  override it):
  - Canvas page in one column: header, plot (full width, ≥ 72vh), then the
    settings panel.
  - The edit column becomes a fixed bottom icon bar: labels hidden, the
    collapse toggle hidden, tooltips "Name: description" via `title`, plus
    `aria-label`.
  - The active tool's `edit-options` open as a fixed sheet above the bar.

- `partEntries` (base geometry per loaded part) → `plotPieces =
  applyPatternEdits(...)` → `PatternSvg` draws one `<g>` per piece (click to
  select, drag = translate edit).
- Layout: the top bar (`plot-toolbar`) holds only the instruction text and
  🖨 Print (also outside edit mode). In edit mode, a collapsible
  **edit-tools sidebar** sits left of the canvas (`plot-body` → `aside.edit-bar`
  + `canvas-wrap`). It contains:
  - the tool buttons, generated from the `editTools` array (icon, label,
    onClick, enabled, active, title, danger?): Cut, Rotate, Merge, Specify,
    Smooth, Define, Name, Delete;
  - ↶ Undo (now only in edit mode);
  - `edit-options`: the ACTIVE tool's controls (Cut now / sub-mode switches /
    Apply / Merge now + merge tolerances / name field …), stacked vertically.
  When collapsed (`editBarCollapsed`, persisted), the bar is icon-only and the
  options are hidden. Starting a tool re-expands it (an effect on
  `toolBusy`). Add new tools to `editTools` + `toolBusy`, and put their
  controls in `edit-options`.
- Cut UI (`cut` state in page.tsx, `CutOverlay` in PatternSvg): click start,
  then end (both snapped onto the outline). Until "Cut now", four handles are
  draggable: start/end (re-snapped onto the outline on each move, re-anchored
  via `cutAnchorFromSnap`) and two control points, drawn as hollow squares with
  tangent lines (`handleCutMoveControl` → `chordRelative` → `CutBow`). A straight
  cut shows its controls at 1/3 and 2/3 of the chord (`STRAIGHT_CUT_BOW`).
  `normalizeCutBow` drops a bow that is effectively straight, so no `bow` is
  saved. The bow is chord-relative, so moving an endpoint keeps the curve's
  shape.
- Cut sub-modes (`cut.mode`: "draw" | "measure", toggled in the toolbar):
  - Measure mode measures **arc length along the outline loop** (it can pass
    corners onto the next seam), in the shorter direction toward the cursor.
    Helpers in split.ts: `buildArcTable`, `arcAt`, `pointAtArc`, `arcDistance`,
    `arcPolyline`. Units are cm.
  - Click a start point; the live distance is shown next to the cursor.
    Typing digits/`.`/`,` replaces it with the typed value (window keydown,
    ignored while focus is in an input). Enter marks the point at the typed
    distance in the current direction (at the cursor if nothing was typed);
    a click marks the clicked point; Esc clears the typed value, then cancels.
  - Each mark ends the measurement. Marks (`cut.marks`, stored as anchors like
    cut endpoints, drawn as orange diamonds M1, M2…) are temporary: they are
    discarded on Cut now/abort and are not saved in the pattern.
  - `snapCut` in PatternSvg snaps to marks and outline corners within
    2.5·unit, in both modes (placing and dragging cut endpoints). So the next
    measurement can start at a mark, and the cut line can start/end on marks.
  - Measure-mode state (start, hover, typed text) lives in PatternSvg and is
    reset when the mode changes.
- `selectedPlotPart` = piece id; `activePartFile` = root part shown in the JSON
  editor.
- **Print to PDF** (toolbar button, available in and out of edit mode →
  `components/PrintModal.tsx`; the logic is in `lib/pdf.ts`, no dependencies):
  - Settings: A4 / A3 / Letter, portrait (default) / landscape, margin 5–15 mm
    (slider, default 10). They are remembered for the session only.
  - Prints `plotPieces` (edits applied) at **1:1** (1 cm = 72/2.54 pt). It
    honours the display toggles: aux lines only if shown; points = markers +
    aux points if "show points" is on; allowance if "show seam allowance" is on.
  - Line styles on the tile pages:
    - seam allowance (cutting line): solid 0.8 pt;
    - pattern lines: dashed `[4 2.5]`;
    - aux lines: grey dash-dot;
    - page frame: dotted (`1 J [0 2.2]`, round caps on zero-length dashes).
  - The overview map draws thin solid lines instead. The tile layout includes
    the allowance extents. The overview page has a legend line.
  - Tiling: printable area = page − 2·margin. `layoutTiles` sizes the grid
    from the pattern bounds and centres the pattern in it. Tiles are named A1,
    A2… (row letter, column number). Tiles without ink are skipped.
  - Page 1 is an overview: info, a 5×5 cm test square, and an assembly map.
    Each tile page has a dashed trim frame, its label, and a footer naming its
    neighbours.
  - The PDF is hand-written: Béziers map to the native `c` operator; text uses
    standard Helvetica/Helvetica-Bold with WinAnsi encoding, and non-Latin-1
    characters become "?". The xref byte offsets assume every character is
    < 256.
  - There are no PDF tools on this machine (no poppler, no browser). The PDF was
    verified by checking xref offsets and stream lengths programmatically, plus
    a throwaway rasterizer that reassembled the tile pages into a PNG.
- `README.md` has more on formula parsing (expr-eval built-in name collisions).
