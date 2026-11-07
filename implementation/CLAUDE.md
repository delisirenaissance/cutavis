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
- page.tsx: one `toolBusy` flag (cut/rotate/merge/specify/smooth) gates all
  `can*` flags and toolbar visibility. Add new tools to it.

- **Line specs** (`lib/types.ts`):
  - `LineSpec {allowance: "seam" | "maxi-allowance-hem" |
    "mini-allowance-hem", marker: MergeMarker | null}`.
  - `ALLOWANCE_MM` gives 10 / 40 / 7 mm. Markers are waistline-, armscye- and
    neckline-front/back. They are informational and NOT printed.
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

- `partEntries` (base geometry per loaded part) → `plotPieces =
  applyPatternEdits(...)` → `PatternSvg` draws one `<g>` per piece (click to
  select, drag = translate edit).
- Edit-mode toolbar: ✂ Cut, ↻ Rotate, ⧉ Merge.
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
