"use client";

import { useEffect, useMemo, useState } from "react";
import { collectVariables, evaluatePart, mergeGeometries, type GeometryResult } from "@/lib/geometry";
import { samplePart } from "@/lib/samplePart";
import {
  MEASUREMENT_SETS,
  MEASUREMENT_SET_NAMES,
  MEASUREMENT_VARIABLE_NAMES,
} from "@/lib/measurementSets";
import {
  BODYFORM_VARIABLES,
  defaultBodyformSelections,
  resolveBodyformValues,
  type BodyformTable,
} from "@/lib/bodyformVariables";
import type { VariableTables } from "@/lib/variableCsv";
import { loadState, saveState, type StoredState } from "@/lib/storage";
import {
  ALLOWANCE_MM,
  ALLOWANCE_TYPES,
  DEFAULT_LINE_SPEC,
  MERGE_MARKERS,
  type AllowanceType,
  type Measurements,
  type MergeMarker,
  type PartDef,
} from "@/lib/types";
import { seamAllowanceOutline } from "@/lib/allowance";
import { findSmoothRun, fitCubicToChain, SMOOTH_SKIP_MAX_CM } from "@/lib/smooth";
import {
  applyPatternEdits,
  belongsToPart,
  migrateEdits,
  rootPartOf,
  patternSignature,
  type PatternEdit,
  type PartPiece,
} from "@/lib/edits";
import {
  extractOuterBoundary,
  boundarySegments,
  buildCutBezier,
  chordRelative,
  normalizeCutBow,
  STRAIGHT_CUT_BOW,
  splitGeometry,
  parsePathBezier,
  nearestParamOnBezier,
  findMergeCandidates,
  pullTogetherOffset,
  type Vec2,
  type CutBow,
  type MergeSeg,
} from "@/lib/split";
import { PatternSvg } from "@/components/PatternSvg";
import { SaveModal } from "@/components/SaveModal";
import { PrintModal } from "@/components/PrintModal";
import { buildPatternPdf, type PrintSettings } from "@/lib/pdf";
import { AddPartModal } from "@/components/AddPartModal";
import InspectorPanel from "@/components/InspectorPanel";

/** One pattern part loaded into the editor and onto the plot. */
interface LoadedPart {
  file: string;
  text: string;
  savedText: string;
}

/** Validate that a part's JSON uses the current object format for points
 *  (not the old tuple format ["expr","expr"]), which would crash geometry.ts. */
function isUsablePartText(text: string | undefined): boolean {
  if (!text) return false;
  try {
    const p = JSON.parse(text);
    const first = Object.values(p.points ?? {})[0];
    return first == null || (!Array.isArray(first) && typeof first === "object");
  } catch {
    return false;
  }
}

type Tab = "measurements" | "display" | "pattern";
type VariableSets = Record<string, string>;

const DEFAULT_SET = MEASUREMENT_SET_NAMES[0];
const DEFAULT_PART_FILE = "skirt";

function defaultVariableSets(): VariableSets {
  return Object.fromEntries(MEASUREMENT_VARIABLE_NAMES.map((n) => [n, DEFAULT_SET]));
}

export default function Home() {
  // All state starts with sensible defaults (safe for SSR).
  // The mount effect below immediately overwrites them from localStorage.
  const [activeTab, setActiveTab] = useState<Tab>("measurements");
  // The parts currently loaded onto the plot. The editor shows one at a time
  // (activePartFile); every loaded part is rendered on the shared plot.
  const [loadedParts, setLoadedParts] = useState<LoadedPart[]>([]);
  const [activePartFile, setActivePartFile] = useState("");
  // Ordered edit history (moves, future splits) applied to the loaded parts.
  const [edits, setEdits] = useState<PatternEdit[]>([]);
  // The pattern file this combination was last loaded/saved as (for overwrite).
  const [currentPatternName, setCurrentPatternName] = useState("");
  const [selectedSet, setSelectedSet] = useState(DEFAULT_SET);
  const [measurements, setMeasurements] = useState<Measurements>(MEASUREMENT_SETS[DEFAULT_SET]);
  const [variableSets, setVariableSets] = useState<VariableSets>(defaultVariableSets);
  const [bodyformSelections, setBodyformSelections] = useState<Record<string, string>>(
    defaultBodyformSelections
  );

  // Variable tables (measurement sets + body-form options). Seeded from the
  // bundled defaults; the "Reload from CSV files" button replaces them with the
  // freshly-parsed contents of the on-disk CSVs.
  const [measurementSets, setMeasurementSets] =
    useState<Record<string, Measurements>>(MEASUREMENT_SETS);
  const [measurementVariableNames, setMeasurementVariableNames] =
    useState<string[]>(MEASUREMENT_VARIABLE_NAMES);
  const [bodyformVariables, setBodyformVariables] = useState<BodyformTable>(BODYFORM_VARIABLES);
  const [reloadStatus, setReloadStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const measurementSetNames = useMemo(() => Object.keys(measurementSets), [measurementSets]);
  const bodyformVariableNames = useMemo(() => Object.keys(bodyformVariables), [bodyformVariables]);

  const [showAuxLines, setShowAuxLines] = useState(false);
  const [showPoints, setShowPoints] = useState(true);
  const [showAllowance, setShowAllowance] = useState(true);

  // Ephemeral UI state — not persisted
  const [partFiles, setPartFiles] = useState<string[]>([]);
  const [patternFiles, setPatternFiles] = useState<string[]>([]);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [savePatternModalOpen, setSavePatternModalOpen] = useState(false);
  const [printModalOpen, setPrintModalOpen] = useState(false);
  // Last-used print settings (kept for the session so the modal reopens with them).
  const [printSettings, setPrintSettings] = useState<PrintSettings>({
    format: "A4",
    orientation: "portrait",
    marginMm: 10,
  });
  // The part currently selected on the plot (highlighted, movable). Independent
  // of activePartFile so clearing the plot selection never empties the editor.
  const [selectedPlotPart, setSelectedPlotPart] = useState<string | null>(null);
  // Signature of the pattern as last loaded/saved — used to detect changes.
  const [savedPatternSig, setSavedPatternSig] = useState<string | null>(null);
  const [patternStatus, setPatternStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  // Whether the Pattern tab is in edit-mode (JSON editor + part dropdown visible).
  const [patternEditMode, setPatternEditMode] = useState(false);
  // Part whose lines are highlighted in blue on the plot (non-edit-mode only).
  const [highlightedPart, setHighlightedPart] = useState<string | null>(null);
  // In-progress cut. `part` is the piece being cut; `from`/`to` are the placed
  // boundary points (anchored by line + parameter t); `bow` curves the cut.
  // `mode` switches between drawing the cut line and measuring distances along
  // the outline; `marks` are the temporary points created by measuring (usable
  // as cut start/end points). Everything is discarded on "Cut now"/abort.
  const [cut, setCut] = useState<{
    part: string;
    mode: "draw" | "measure";
    marks: { line: string; t: number; point: Vec2 }[];
    from?: { line: string; t: number; point: Vec2 };
    to?: { line: string; t: number; point: Vec2 };
    bow?: CutBow;
  } | null>(null);
  // In-progress rotation. `part` is the piece; `center` is the rotation center
  // anchored on a seam (definition-relative t) once picked. The angle is chosen
  // by a click-hold-drag on the plot and committed on release.
  const [rotate, setRotate] = useState<{
    part: string;
    center?: { line: string; t: number; point: Vec2 };
  } | null>(null);
  // In-progress merge: `sel` is the first picked line; `cand` the matching line
  // chosen from the candidates. Tolerances x (angle°) and y (length %) are
  // configurable next to the button.
  const [merge, setMerge] = useState<{
    sel?: { pieceId: string; line: string };
    cand?: { pieceId: string; line: string };
  } | null>(null);
  const [mergeAngle, setMergeAngle] = useState(5);
  const [mergeLenPct, setMergeLenPct] = useState(10);
  // "Specify line" mode: `sel` is the picked line; `allowance`/`marker` are the
  // values in the dropdowns (prefilled from the line's current spec).
  const [specify, setSpecify] = useState<{
    sel?: { pieceId: string; line: string };
    allowance: AllowanceType;
    marker: MergeMarker | null;
  } | null>(null);
  // "Smooth" mode: the piece and the outline lines picked so far (≥ 2
  // consecutive ones can be replaced by one fitted cubic).
  const [smooth, setSmooth] = useState<{ pieceId?: string; lines: string[] } | null>(null);

  // ── Persistence: write a snapshot of all current state plus any overrides ──

  function persist(overrides: Partial<StoredState> = {}) {
    // Values from the closure are the current React state at call time.
    // Overrides carry new values that were just computed in the same handler
    // (since setState is asynchronous and the closure still holds old values).
    saveState({
      activeTab,
      loadedParts,
      activePartFile,
      edits,
      currentPatternName,
      selectedSet,
      measurements,
      variableSets,
      bodyformSelections,
      showAuxLines,
      showPoints,
      showAllowance,
      ...overrides,
    });
  }

  // ── Mount: restore from storage, then load the default part file if needed ──

  useEffect(() => {
    // Fetch available part files
    fetch("/api/parts")
      .then((r) => r.json())
      .then((files: string[]) => setPartFiles(files))
      .catch(() => {});

    // Fetch available pattern files
    fetch("/api/patterns")
      .then((r) => r.json())
      .then((files: string[]) => setPatternFiles(files))
      .catch(() => {});

    // Restore persisted state
    const stored = loadState();

    if (stored.activeTab) {
      // The old standalone "Edit Pattern" tab is now the Pattern tab's edit-mode.
      if (stored.activeTab === "edit-part") {
        setActiveTab("pattern");
        setPatternEditMode(true);
      } else {
        setActiveTab(stored.activeTab);
      }
    }
    if (stored.edits)                      setEdits(migrateEdits(stored.edits));
    if (stored.currentPatternName) {
      setCurrentPatternName(stored.currentPatternName);
    }
    if (stored.selectedSet)                setSelectedSet(stored.selectedSet);
    if (stored.measurements)               setMeasurements(stored.measurements);
    if (stored.variableSets)               setVariableSets(stored.variableSets);
    if (stored.bodyformSelections)         setBodyformSelections({ ...defaultBodyformSelections(), ...stored.bodyformSelections });
    if (stored.showAuxLines !== undefined) setShowAuxLines(stored.showAuxLines);
    if (stored.showPoints   !== undefined) setShowPoints(stored.showPoints);
    if (stored.showAllowance !== undefined) setShowAllowance(stored.showAllowance);

    // ── Restore the loaded parts ────────────────────────────────────────────
    // Prefer the new multi-part storage; otherwise migrate the old single-part
    // fields; otherwise load the default part fresh from disk.
    const usableStored = (stored.loadedParts ?? []).filter((p) => isUsablePartText(p.text));
    if (usableStored.length > 0) {
      setLoadedParts(usableStored);
      const active = usableStored.some((p) => p.file === stored.activePartFile)
        ? stored.activePartFile!
        : usableStored[0].file;
      setActivePartFile(active);
      return;
    }

    if (isUsablePartText(stored.partText)) {
      // Migrate legacy single-part storage into one loaded part.
      const file = stored.selectedPartFile || DEFAULT_PART_FILE;
      const part: LoadedPart = {
        file,
        text: stored.partText!,
        savedText: stored.lastSavedPartText ?? stored.partText!,
      };
      setLoadedParts([part]);
      setActivePartFile(file);
      saveState({ ...stored, loadedParts: [part], activePartFile: file });
      return;
    }

    // First visit, stale format, or invalid JSON — load the default part fresh.
    fetch(`/api/parts/${DEFAULT_PART_FILE}`)
      .then((r) => r.text())
      .then((text) => {
        const pretty = JSON.stringify(JSON.parse(text), null, 2);
        const part: LoadedPart = { file: DEFAULT_PART_FILE, text: pretty, savedText: pretty };
        setLoadedParts([part]);
        setActivePartFile(DEFAULT_PART_FILE);
        saveState({ ...stored, loadedParts: [part], activePartFile: DEFAULT_PART_FILE });
      })
      .catch(() => {
        const fallback = JSON.stringify(samplePart, null, 2);
        const part: LoadedPart = { file: DEFAULT_PART_FILE, text: fallback, savedText: fallback };
        setLoadedParts([part]);
        setActivePartFile(DEFAULT_PART_FILE);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  // ── Geometry pipeline (derived, not persisted) ────────────────────────────

  // Body-form selections resolve to numeric values bound to their variable names.
  const bodyformValues = useMemo(
    () => resolveBodyformValues(bodyformSelections, bodyformVariables),
    [bodyformSelections, bodyformVariables]
  );

  // Measurements and body-form values share one namespace for formula lookup.
  const variableValues = useMemo(
    () => ({ ...measurements, ...bodyformValues }),
    [measurements, bodyformValues]
  );

  // Evaluate every loaded part independently. Each part gets its own scope:
  // shared measurements + body-form values, plus that part's user-definable
  // variables (which take precedence on name clashes). We provide ALL known
  // values rather than only the formula-detected subset so that local_variables
  // and point formulas can reference any of them — even names that collide with
  // expr-eval built-ins (e.g. `length`), which the detector can't always see.
  // Any remaining detected-but-unknown name still defaults to 0 so partial edits
  // keep rendering.
  // Parse and evaluate each loaded part's BASE geometry (before edits). Edits
  // are replayed separately (below) so this only re-runs on text/measurement
  // changes, not on every move.
  const partEntries = useMemo(() => {
    return loadedParts.map((lp) => {
      let part: PartDef | null = null;
      let parseError: string | null = null;
      try {
        part = JSON.parse(lp.text) as PartDef;
      } catch (err) {
        parseError = (err as Error).message;
      }
      let base: GeometryResult | null = null;
      if (part) {
        const s: Measurements = {
          ...variableValues,
          ...(part.part_specific_user_definable_variables ?? {}),
        };
        for (const v of collectVariables(part)) if (!(v in s)) s[v] = 0;
        base = evaluatePart(part, s);
      }
      return { file: lp.file, part, parseError, base };
    });
  }, [loadedParts, variableValues]);

  // Replay each part's edit history, expanding splits into separate pieces.
  // One loaded part becomes one piece (its file id) until a cut turns it into
  // derived parts (file_1, file_2, …; cutting file_2 again gives file_2_1, …),
  // each independently selectable, movable, rotatable and cuttable.
  const plotPieces = useMemo(() => {
    const bases: PartPiece[] = partEntries
      .filter((e) => e.base)
      .map((e) => ({ id: e.file, geometry: e.base! }));
    return applyPatternEdits(bases, edits);
  }, [partEntries, edits]);

  const loadedFiles = useMemo(() => loadedParts.map((p) => p.file), [loadedParts]);

  // Derived parts (created by cuts/merges) currently on the plot, per loaded
  // part file, in natural order (file_1, file_2, file_2_1, …, file_10).
  const derivedPartsByFile = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const f of loadedFiles) {
      out[f] = plotPieces
        .map((p) => p.id)
        .filter((id) => id !== f && belongsToPart(id, f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }
    return out;
  }, [plotPieces, loadedFiles]);

  // Merge all pieces' geometry into one result drawn on a shared plot.
  const merged = useMemo(
    () => mergeGeometries(plotPieces.map((p) => ({ id: p.id, geometry: p.geometry }))),
    [plotPieces]
  );

  // The part currently shown in the editor (a loaded part / root, never a piece).
  const activeEntry = partEntries.find((p) => p.file === activePartFile) ?? null;
  const activeLoaded = loadedParts.find((p) => p.file === activePartFile) ?? null;
  const activePart = activeEntry?.part ?? null;
  const activeParseError = activeEntry?.parseError ?? null;
  const activeText = activeLoaded?.text ?? "";

  // How many loaded parts define each user-definable variable name. Used to flag
  // variables that are shared across parts (an edit applies to all of them).
  const varPartCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const pg of partEntries) {
      for (const k of Object.keys(pg.part?.part_specific_user_definable_variables ?? {})) {
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    return counts;
  }, [partEntries]);

  const formulaErrors = Object.entries(merged.errors);

  // Save button is enabled only when the active part's editor content differs
  // from the last file load or save (i.e., there are unsaved changes).
  const isDirty = activeLoaded != null && activeLoaded.text !== activeLoaded.savedText;

  // The pieces drawn on the plot (edits already applied) — selectable groups.
  const plotParts = plotPieces;

  // ── Cut (split) derived state ──────────────────────────────────────────────

  // The currently-selected piece and whether it forms a closed outline (only a
  // closed outline can be cut). Used to enable the scissors button.
  const selectedPiece = useMemo(
    () => plotPieces.find((p) => p.id === selectedPlotPart) ?? null,
    [plotPieces, selectedPlotPart]
  );
  const selectedCuttable = useMemo(
    () => (selectedPiece ? extractOuterBoundary(boundarySegments(selectedPiece.geometry)).ok : false),
    [selectedPiece]
  );
  // Only one edit tool (cut / rotate / merge / specify / smooth) at a time.
  const toolBusy = cut != null || rotate != null || merge != null || specify != null || smooth != null;
  const canCut = patternEditMode && !toolBusy && selectedPiece != null && selectedCuttable;
  const canRotate = patternEditMode && !toolBusy && selectedPiece != null && selectedCuttable;
  const canMerge = patternEditMode && !toolBusy && plotPieces.length >= 2;
  const canSpecify = patternEditMode && !toolBusy && plotPieces.length > 0;
  const canSmooth = patternEditMode && !toolBusy && plotPieces.length > 0;

  // The piece being cut and its outline loop (to snap clicks onto).
  const cutPiece = useMemo(
    () => (cut ? plotPieces.find((p) => p.id === cut.part) ?? null : null),
    [cut, plotPieces]
  );
  const cutLoop = useMemo(
    () => (cutPiece ? extractOuterBoundary(boundarySegments(cutPiece.geometry)).loop : []),
    [cutPiece]
  );
  const cutPhase: "start" | "end" | "adjust" =
    !cut ? "start" : !cut.from ? "start" : !cut.to ? "end" : "adjust";
  // Preview curve between the two placed points (with any bow).
  const cutPreview = useMemo(
    () => (cut?.from && cut?.to ? buildCutBezier(cut.from.point, cut.to.point, cut.bow) : null),
    [cut]
  );
  // Positions of the two draggable control handles. A straight cut (no bow)
  // shows them on the chord at 1/3 and 2/3.
  const cutControls = useMemo((): [Vec2, Vec2] | null => {
    if (!cut?.from || !cut?.to) return null;
    const b = buildCutBezier(cut.from.point, cut.to.point, cut.bow ?? STRAIGHT_CUT_BOW);
    return [b[1], b[2]];
  }, [cut]);
  // Would this cut actually divide the part? (Reuses the real split logic.)
  const cutValid = useMemo(() => {
    if (!cut?.from || !cut?.to || !cutPiece) return false;
    return (
      splitGeometry(
        cutPiece.geometry,
        { line: cut.from.line, t: cut.from.t },
        { line: cut.to.line, t: cut.to.t },
        cut.bow
      ) != null
    );
  }, [cut, cutPiece]);
  const cutInstruction =
    cut?.mode === "measure"
      ? "Measure: click a start point on the outline, then move along it — the distance is shown at the cursor. Click, or type a value (cm) + Enter, to mark the point. Esc cancels."
      : cutPhase === "start"
      ? "Draw a line where to cut the part: first, the start point (snaps to marks)."
      : cutPhase === "end"
      ? "…and now the end point."
      : "Drag the start/end points along the outline, or the two hollow control points to curve the cut — then press “Cut now”.";

  // ── Rotate derived state ───────────────────────────────────────────────────
  const rotatePiece = useMemo(
    () => (rotate ? plotPieces.find((p) => p.id === rotate.part) ?? null : null),
    [rotate, plotPieces]
  );
  const rotateLoop = useMemo(
    () => (rotatePiece ? extractOuterBoundary(boundarySegments(rotatePiece.geometry)).loop : []),
    [rotatePiece]
  );
  const rotateInstruction = !rotate
    ? ""
    : !rotate.center
    ? "Select the rotation center: click a point on a seam."
    : "Click and hold, then drag to rotate the part around the center.";

  // ── Merge derived state ────────────────────────────────────────────────────
  // Outer-boundary segments of every piece (for the merge hover/pick overlay).
  const allOutlineSegs = useMemo(() => {
    const segs: { pieceId: string; line: string; bezier: import("@/lib/split").Bezier }[] = [];
    for (const p of plotPieces) {
      const ob = extractOuterBoundary(boundarySegments(p.geometry));
      if (ob.ok) for (const s of ob.loop) segs.push({ pieceId: p.id, line: s.line, bezier: s.bezier });
    }
    return segs;
  }, [plotPieces]);

  // Candidate lines for the currently selected line.
  const mergeCandidates: MergeSeg[] = useMemo(() => {
    if (!merge?.sel) return [];
    return findMergeCandidates(plotPieces, merge.sel.pieceId, merge.sel.line, mergeAngle, mergeLenPct);
  }, [merge?.sel, plotPieces, mergeAngle, mergeLenPct]);

  // Role-tagged segments handed to the plot overlay.
  const mergeOverlaySegs = useMemo(() => {
    if (!merge) return [];
    const candSet = new Set(mergeCandidates.map((c) => `${c.pieceId}::${c.line}`));
    const selKey = merge.sel ? `${merge.sel.pieceId}::${merge.sel.line}` : null;
    const candKey = merge.cand ? `${merge.cand.pieceId}::${merge.cand.line}` : null;
    return allOutlineSegs.map((s) => {
      const key = `${s.pieceId}::${s.line}`;
      let role: "plain" | "selected" | "candidate" | "chosen" | "dim" = "plain";
      let clickable = false;
      if (!merge.sel) {
        role = "plain"; clickable = true; // phase 1: pick any line
      } else if (key === selKey) {
        role = "selected";
      } else if (key === candKey) {
        role = "chosen"; clickable = true;
      } else if (candSet.has(key)) {
        role = "candidate"; clickable = true;
      } else {
        role = "dim";
      }
      return { key, bezier: s.bezier, role, clickable };
    });
  }, [merge, mergeCandidates, allOutlineSegs]);

  // ── Specify-line derived state ─────────────────────────────────────────────
  // Every outline line is pickable; lines that already have a non-default spec
  // are shown green, the picked line highlighted.
  const specifyOverlaySegs = useMemo(() => {
    if (!specify) return [];
    const selKey = specify.sel ? `${specify.sel.pieceId}::${specify.sel.line}` : null;
    const geomById = new Map(plotPieces.map((p) => [p.id, p.geometry]));
    return allOutlineSegs.map((s) => {
      const key = `${s.pieceId}::${s.line}`;
      const spec = geomById.get(s.pieceId)?.lineSpecs?.[s.line];
      const specified = !!spec && (spec.allowance !== "seam" || spec.marker != null);
      const role: "plain" | "selected" | "candidate" =
        key === selKey ? "selected" : specified ? "candidate" : "plain";
      return { key, bezier: s.bezier, role, clickable: true };
    });
  }, [specify, allOutlineSegs, plotPieces]);

  const specifyInstruction = !specify
    ? ""
    : !specify.sel
    ? "Specify line: click a line on the plot (green = already specified)."
    : `Line ${specify.sel.line} of ${specify.sel.pieceId}: choose its type and merge marker, then “Apply”.`;

  // ── Smooth derived state ───────────────────────────────────────────────────
  const smoothPiece = smooth?.pieceId ? plotPieces.find((p) => p.id === smooth.pieceId) ?? null : null;
  // The run for the current selection (incl. auto-included short gap lines)
  // and its fitted curve; both null unless the selection is a valid run.
  const smoothRun = useMemo(
    () => (smooth && smoothPiece ? findSmoothRun(smoothPiece.geometry, smooth.lines) : null),
    [smooth, smoothPiece]
  );
  const smoothCurve = useMemo(() => (smoothRun ? fitCubicToChain(smoothRun.segs) : null), [smoothRun]);
  const smoothOverlaySegs = useMemo(() => {
    if (!smooth) return [];
    const chosen = new Set(smoothRun ? smoothRun.lines : smooth.lines);
    const segs = allOutlineSegs.map((s) => {
      const mine = s.pieceId === smooth.pieceId;
      const role: "plain" | "selected" | "dim" =
        mine && chosen.has(s.line) ? "selected" : smooth.pieceId && !mine ? "dim" : "plain";
      return { key: `${s.pieceId}::${s.line}`, bezier: s.bezier, role, clickable: true };
    });
    // Live preview of the smoothed curve (orange, not clickable).
    return smoothCurve
      ? [...segs, { key: "__smooth_preview", bezier: smoothCurve, role: "chosen" as const, clickable: false }]
      : segs;
  }, [smooth, smoothRun, allOutlineSegs, smoothCurve]);

  const smoothInstruction = !smooth
    ? ""
    : smooth.lines.length < 2
    ? `Smooth: click at least 2 consecutive outline lines of one part (click again to deselect). Lines ≤ ${SMOOTH_SKIP_MAX_CM} cm between them are included automatically.`
    : smoothRun && smoothCurve
    ? `${smoothRun.lines.length} lines selected${
        smoothRun.lines.length > smooth.lines.length
          ? ` (${smoothRun.lines.length - smooth.lines.length} short one${smoothRun.lines.length - smooth.lines.length === 1 ? "" : "s"} auto-included)`
          : ""
      } — the orange curve previews the result. Press “Smooth now”.`
    : `The selected lines must be consecutive along the outline (gaps of lines ≤ ${SMOOTH_SKIP_MAX_CM} cm are fine) and not the whole outline.`;

  // Seam-allowance polygons per piece for the plot.
  const allowanceByPiece = useMemo(() => {
    if (!showAllowance) return {};
    const out: Record<string, Vec2[]> = {};
    for (const p of plotPieces) {
      const poly = seamAllowanceOutline(p.geometry);
      if (poly) out[p.id] = poly;
    }
    return out;
  }, [plotPieces, showAllowance]);

  const mergeInstruction = !merge
    ? ""
    : !merge.sel
    ? "Merge: click a line on a part."
    : !merge.cand
    ? mergeCandidates.length === 0
      ? "No matching lines found — adjust the ° / % tolerances."
      : "Pick a matching line (green) to merge with."
    : "“Pull together” to align the parts, then “Merge now”.";

  // The current pattern (loaded parts + edits) differs from the last save?
  const currentPatternSig = patternSignature(loadedParts.map((p) => p.file), edits);
  const patternDirty = savedPatternSig != null && currentPatternSig !== savedPatternSig;

  // ── Event handlers (each calls persist() with the new values) ─────────────

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    persist({ activeTab: tab });
  }

  // Enter the Pattern tab's edit-mode (shows the JSON editor + part dropdown).
  // Clear the blue name-highlight, which is a non-edit-mode affordance.
  function enterPatternEdit() {
    setPatternEditMode(true);
    setHighlightedPart(null);
  }

  function exitPatternEdit() {
    setPatternEditMode(false);
    // Drop the orange plot selection so the overview view stays clean.
    setSelectedPlotPart(null);
    setCut(null);
    setRotate(null);
    setMerge(null);
    setSpecify(null);
    setSmooth(null);
  }

  // Non-edit-mode: click a part name to highlight its plot lines in blue.
  // Clicking the already-highlighted part clears the highlight.
  function handleHighlightPart(filename: string) {
    setHighlightedPart((cur) => (cur === filename ? null : filename));
  }

  // Replace the active part's editor text (re-renders the plot immediately).
  function setActivePartText(text: string) {
    if (!activePartFile) return;
    const next = loadedParts.map((p) =>
      p.file === activePartFile ? { ...p, text } : p
    );
    setLoadedParts(next);
    persist({ loadedParts: next });
  }

  function handlePartTextChange(text: string) {
    setActivePartText(text);
  }

  // Edit a part_specific_user_definable_variable: write the new value straight
  // back into the JSON so the editor and the geometry stay in sync. When the
  // same variable name is defined by several loaded parts, the change is applied
  // to ALL of them at once so shared customizations stay consistent.
  function handlePartVariableChange(name: string, value: number) {
    const next = loadedParts.map((lp) => {
      let parsed: PartDef;
      try {
        parsed = JSON.parse(lp.text) as PartDef;
      } catch {
        return lp; // leave parts with invalid JSON untouched
      }
      const vars = parsed.part_specific_user_definable_variables;
      if (!vars || !(name in vars)) return lp; // only parts that define it
      const updated: PartDef = {
        ...parsed,
        part_specific_user_definable_variables: { ...vars, [name]: value },
      };
      return { ...lp, text: JSON.stringify(updated, null, 2) };
    });
    setLoadedParts(next);
    persist({ loadedParts: next });
  }

  // Make a loaded part the one shown in the editor.
  function handleSelectPart(filename: string) {
    setActivePartFile(filename);
    persist({ activePartFile: filename });
  }

  // Load a part file from disk and add it to the plot (also selects it).
  async function handleAddPart(filename: string) {
    setAddModalOpen(false);
    if (!filename) return;
    if (loadedParts.some((p) => p.file === filename)) {
      handleSelectPart(filename);
      return;
    }
    let text: string;
    try {
      const res = await fetch(`/api/parts/${filename}`);
      const raw = await res.text();
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch (err) {
      text = `// Failed to load ${filename}: ${(err as Error).message}`;
    }
    const next = [...loadedParts, { file: filename, text, savedText: text }];
    setLoadedParts(next);
    setActivePartFile(filename);
    persist({ loadedParts: next, activePartFile: filename });
  }

  // Remove a part from the plot (and from the rendering logic). Its edit history
  // is dropped too, since edits reference the part by file id.
  function handleRemovePart(filename: string) {
    const next = loadedParts.filter((p) => p.file !== filename);
    const active = activePartFile === filename ? next[0]?.file ?? "" : activePartFile;
    // Drop every edit that references this part family — including derived
    // parts from cuts (file_1, file_2_1, …) and merges that involve it.
    const ofPart = (id: string) => belongsToPart(id, filename);
    const touches = (e: PatternEdit): boolean =>
      e.type === "merge" ? ofPart(e.partA) || ofPart(e.partB) : ofPart(e.part);
    const nextEdits = edits.filter((e) => !touches(e));
    setLoadedParts(next);
    setActivePartFile(active);
    setEdits(nextEdits);
    if (selectedPlotPart && ofPart(selectedPlotPart)) setSelectedPlotPart(null);
    if (highlightedPart && ofPart(highlightedPart)) setHighlightedPart(null);
    if (cut && ofPart(cut.part)) setCut(null);
    if (rotate && ofPart(rotate.part)) setRotate(null);
    if (merge) setMerge(null);
    if (specify?.sel && ofPart(specify.sel.pieceId)) setSpecify((s) => (s ? { ...s, sel: undefined } : s));
    if (smooth?.pieceId && ofPart(smooth.pieceId)) setSmooth({ lines: [] });
    persist({ loadedParts: next, activePartFile: active, edits: nextEdits });
  }

  // ── Plot interaction: select / move / undo ────────────────────────────────

  // Select a part on the plot. Also make it the editor's active part so the two
  // views stay in sync; clearing the plot selection leaves the editor untouched.
  function handlePlotSelect(id: string | null) {
    setSelectedPlotPart(id);
    if (id) {
      // A plot piece may be a derived part (e.g. "skirt_2_1"); the JSON editor
      // tracks the loaded part file it was derived from.
      const root = rootPartOf(id, loadedFiles);
      if (root) {
        setActivePartFile(root);
        persist({ activePartFile: root });
      }
    }
  }

  // Commit a drag as one undoable translate edit.
  function handleMovePart(id: string, dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    const nextEdits: PatternEdit[] = [...edits, { type: "translate", part: id, dx, dy }];
    setEdits(nextEdits);
    persist({ edits: nextEdits });
  }

  // ── Print to PDF ───────────────────────────────────────────────────────────

  // What gets printed mirrors the plot's display settings.
  const printOptions = useMemo(
    () => ({ showAuxLines, showPoints, showAllowance }),
    [showAuxLines, showPoints, showAllowance]
  );

  // Build the tiled 1:1 PDF of the current pattern (all pieces, edits applied)
  // and download it.
  function handleCreatePdf(settings: PrintSettings) {
    const title = currentPatternName || "cutavis pattern";
    const res = buildPatternPdf(plotPieces, settings, printOptions, {
      title,
      info: [
        `Parts: ${plotPieces.map((p) => p.id).join(", ")}`,
        `Measurements: ${selectedSet} - created ${new Date().toLocaleString()}`,
      ],
    });
    if (!res) throw new Error("Nothing to print.");
    const blob = new Blob([res.bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w.-]+/g, "_")}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setPrintSettings(settings);
    setPrintModalOpen(false);
  }

  // Undo the most recent edit in the history.
  function handleUndo() {
    if (edits.length === 0) return;
    const nextEdits = edits.slice(0, -1);
    setEdits(nextEdits);
    persist({ edits: nextEdits });
  }

  // ── Cut (split) interaction ────────────────────────────────────────────────

  function startCut() {
    if (!canCut || !selectedPlotPart) return;
    setCut({ part: selectedPlotPart, mode: "draw", marks: [] });
  }

  function setCutMode(mode: "draw" | "measure") {
    setCut((c) => (c ? { ...c, mode } : c));
  }

  // Measure mode: keep the measured end point as a temporary mark.
  function handleAddCutMark(snap: { line: string; t: number; point: Vec2 }) {
    const mark = cutAnchorFromSnap(snap);
    setCut((c) => (c ? { ...c, marks: [...c.marks, mark] } : c));
  }

  function clearCutMarks() {
    setCut((c) => (c ? { ...c, marks: [] } : c));
  }

  function abortCut() {
    setCut(null);
  }

  // Place the next cut point (already snapped onto the outline). The snap's t is
  // relative to the outline-walk direction, which isn't stable across
  // measurement changes — so re-express it along the line's definition direction
  // before storing, keeping `point` (definition-independent) for the preview.
  function cutAnchorFromSnap(snap: { line: string; t: number; point: Vec2 }) {
    const def = cutPiece ? parsePathBezier(cutPiece.geometry.paths[snap.line]) : null;
    const tDef = def ? nearestParamOnBezier(def, snap.point) : snap.t;
    return { line: snap.line, t: tDef, point: snap.point };
  }

  function handleCutPlace(snap: { line: string; t: number; point: Vec2 }) {
    const anchor = cutAnchorFromSnap(snap);
    setCut((c) => {
      if (!c) return c;
      if (!c.from) return { ...c, from: anchor };
      if (!c.to) return { ...c, to: anchor };
      return c;
    });
  }

  // Drag a placed start/end point along the outline (re-snapped by the plot).
  // The control points are chord-relative, so the curve's shape follows along.
  function handleCutMoveEnd(which: "from" | "to", snap: { line: string; t: number; point: Vec2 }) {
    const anchor = cutAnchorFromSnap(snap);
    setCut((c) => (c && c[which] ? { ...c, [which]: anchor } : c));
  }

  // Drag one of the two Bézier control points of the cut curve to an absolute
  // position; it is stored relative to the start→end chord.
  function handleCutMoveControl(which: "c1" | "c2", p: Vec2) {
    setCut((c) => {
      if (!c || !c.from || !c.to) return c;
      const current = c.bow ?? STRAIGHT_CUT_BOW;
      const bow: CutBow = { ...current, [which]: chordRelative(c.from.point, c.to.point, p) };
      return { ...c, bow: normalizeCutBow(bow) };
    });
  }

  // Commit the cut as a split edit — the part becomes two movable pieces.
  function commitCut() {
    if (!cut?.from || !cut?.to || !cutValid) return;
    const edit: PatternEdit = {
      type: "split",
      part: cut.part,
      from: { line: cut.from.line, t: cut.from.t },
      to: { line: cut.to.line, t: cut.to.t },
      bow: cut.bow,
    };
    const nextEdits = [...edits, edit];
    setEdits(nextEdits);
    setCut(null);
    setSelectedPlotPart(null);
    persist({ edits: nextEdits });
  }

  // ── Rotate interaction ─────────────────────────────────────────────────────

  function startRotate() {
    if (!canRotate || !selectedPlotPart) return;
    setRotate({ part: selectedPlotPart });
  }

  function abortRotate() {
    setRotate(null);
  }

  // Pick the rotation center on a seam. Store t along the line's definition
  // direction (measurement-stable), like the cut anchors.
  function handleRotateCenter(snap: { line: string; t: number; point: Vec2 }) {
    const def = rotatePiece ? parsePathBezier(rotatePiece.geometry.paths[snap.line]) : null;
    const tDef = def ? nearestParamOnBezier(def, snap.point) : snap.t;
    setRotate((r) => (r ? { ...r, center: { line: snap.line, t: tDef, point: snap.point } } : r));
  }

  // Commit the rotation as an edit once the drag ends.
  function handleRotateCommit(angle: number) {
    if (!rotate?.center || Math.abs(angle) < 1e-4) {
      setRotate(null);
      return;
    }
    const edit: PatternEdit = {
      type: "rotate",
      part: rotate.part,
      center: { line: rotate.center.line, t: rotate.center.t },
      angle,
    };
    const nextEdits = [...edits, edit];
    setEdits(nextEdits);
    setRotate(null);
    setSelectedPlotPart(null);
    persist({ edits: nextEdits });
  }

  // ── Merge interaction ──────────────────────────────────────────────────────

  function startMerge() {
    if (!canMerge) return;
    setMerge({});
  }

  function abortMerge() {
    setMerge(null);
  }

  // ── Smooth interaction ─────────────────────────────────────────────────────

  function startSmooth() {
    if (!canSmooth) return;
    setSmooth({ lines: [] });
  }

  // Toggle a line in the selection; picking a line of another piece starts a
  // new selection on that piece.
  function handleSmoothPick(key: string) {
    const sep = key.indexOf("::");
    const pieceId = key.slice(0, sep);
    const line = key.slice(sep + 2);
    setSmooth((s) => {
      if (!s) return s;
      if (s.pieceId !== pieceId) return { pieceId, lines: [line] };
      const lines = s.lines.includes(line) ? s.lines.filter((l) => l !== line) : [...s.lines, line];
      return { pieceId: lines.length ? pieceId : undefined, lines };
    });
  }

  // Commit the smoothing as an edit. The stored lines are the full run in
  // outline order — including auto-included short lines — so the replay
  // doesn't depend on the ≤ 1 cm rule (a short line may grow with measurements).
  function commitSmooth() {
    if (!smooth?.pieceId || !smoothRun) return;
    const nextEdits: PatternEdit[] = [...edits, { type: "smooth", part: smooth.pieceId, lines: smoothRun.lines }];
    setEdits(nextEdits);
    persist({ edits: nextEdits });
    setSmooth(null);
  }

  // ── Specify-line interaction ───────────────────────────────────────────────

  function startSpecify() {
    if (!canSpecify) return;
    setSpecify({ ...DEFAULT_LINE_SPEC });
  }

  // Pick a line; the dropdowns are prefilled with its current specification.
  function handleSpecifyPick(key: string) {
    const sep = key.indexOf("::");
    const pieceId = key.slice(0, sep);
    const line = key.slice(sep + 2);
    const spec = plotPieces.find((p) => p.id === pieceId)?.geometry.lineSpecs?.[line] ?? DEFAULT_LINE_SPEC;
    setSpecify({ sel: { pieceId, line }, allowance: spec.allowance, marker: spec.marker });
  }

  // Store the chosen spec as an undoable edit; stay in the mode for the next line.
  function applySpecify() {
    if (!specify?.sel) return;
    const edit: PatternEdit = {
      type: "lineSpec",
      part: specify.sel.pieceId,
      line: specify.sel.line,
      allowance: specify.allowance,
      marker: specify.marker,
    };
    const nextEdits = [...edits, edit];
    setEdits(nextEdits);
    persist({ edits: nextEdits });
    setSpecify({ ...DEFAULT_LINE_SPEC });
  }

  // Pick a line: first click sets the selected line, second sets the merge line.
  function handleMergePick(key: string) {
    const sep = key.indexOf("::");
    const pieceId = key.slice(0, sep);
    const line = key.slice(sep + 2);
    setMerge((m) => {
      if (!m) return m;
      if (!m.sel) return { ...m, sel: { pieceId, line } };
      return { ...m, cand: { pieceId, line } };
    });
  }

  // Translate the merging part so its line best aligns with the selected line.
  function pullTogether() {
    if (!merge?.sel || !merge?.cand) return;
    const gSel = plotPieces.find((p) => p.id === merge.sel!.pieceId);
    const gCand = plotPieces.find((p) => p.id === merge.cand!.pieceId);
    if (!gSel || !gCand) return;
    const off = pullTogetherOffset(gSel.geometry, merge.sel.line, gCand.geometry, merge.cand.line);
    if (!off || (Math.abs(off.dx) < 1e-6 && Math.abs(off.dy) < 1e-6)) return;
    const edit: PatternEdit = { type: "translate", part: merge.cand.pieceId, dx: off.dx, dy: off.dy };
    const nextEdits = [...edits, edit];
    setEdits(nextEdits);
    persist({ edits: nextEdits });
  }

  // Commit the merge: the two parts become one combined piece.
  function mergeNow() {
    if (!merge?.sel || !merge?.cand) return;
    const edit: PatternEdit = {
      type: "merge",
      partA: merge.sel.pieceId,
      lineA: merge.sel.line,
      partB: merge.cand.pieceId,
      lineB: merge.cand.line,
    };
    const nextEdits = [...edits, edit];
    setEdits(nextEdits);
    setMerge(null);
    setSelectedPlotPart(null);
    persist({ edits: nextEdits });
  }

  function handleSetChange(setName: string) {
    const newMeasurements = { ...measurementSets[setName] };
    const newVariableSets = Object.fromEntries(measurementVariableNames.map((n) => [n, setName]));
    setSelectedSet(setName);
    setMeasurements(newMeasurements);
    setVariableSets(newVariableSets);
    persist({ selectedSet: setName, measurements: newMeasurements, variableSets: newVariableSets });
  }

  function handleVariableSetChange(varName: string, setName: string) {
    const newMeasurements = { ...measurements, [varName]: measurementSets[setName][varName] };
    const newVariableSets = { ...variableSets, [varName]: setName };
    setMeasurements(newMeasurements);
    setVariableSets(newVariableSets);
    persist({ measurements: newMeasurements, variableSets: newVariableSets });
  }

  // Re-read the on-disk CSVs and replace the in-app variable tables, then
  // refresh the editable measurements and dropdown options to match.
  async function handleReloadCsv() {
    setReloadStatus(null);
    try {
      const res = await fetch("/api/variables", { cache: "no-store" });
      const data = (await res.json()) as VariableTables & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      const setNames = Object.keys(data.measurementSets);
      if (setNames.length === 0) throw new Error("No measurement sets found in CSV");

      // Keep the current set selected if it still exists, else fall back to the first.
      const newSet = setNames.includes(selectedSet) ? selectedSet : setNames[0];
      const newMeasurements = { ...data.measurementSets[newSet] };
      const newVariableSets = Object.fromEntries(
        data.measurementVariableNames.map((n) => [n, newSet])
      );

      // Preserve each body-form choice if its option text still exists; else default to the first.
      const newBodyformSelections: Record<string, string> = {};
      for (const [name, opts] of Object.entries(data.bodyformVariables)) {
        const current = bodyformSelections[name];
        newBodyformSelections[name] = opts.some((o) => o.text === current)
          ? current
          : opts[0]?.text ?? "";
      }

      setMeasurementSets(data.measurementSets);
      setMeasurementVariableNames(data.measurementVariableNames);
      setBodyformVariables(data.bodyformVariables);
      setSelectedSet(newSet);
      setMeasurements(newMeasurements);
      setVariableSets(newVariableSets);
      setBodyformSelections(newBodyformSelections);
      persist({
        selectedSet: newSet,
        measurements: newMeasurements,
        variableSets: newVariableSets,
        bodyformSelections: newBodyformSelections,
      });

      setReloadStatus({
        ok: true,
        msg: `Loaded ${data.measurementVariableNames.length} measurements, ${setNames.length} set(s), ${Object.keys(data.bodyformVariables).length} body-form variable(s).`,
      });
    } catch (err) {
      setReloadStatus({ ok: false, msg: (err as Error).message });
    }
  }

  function handleMeasurementChange(name: string, value: number) {
    const newMeasurements = { ...measurements, [name]: value };
    setMeasurements(newMeasurements);
    persist({ measurements: newMeasurements });
  }

  function handleBodyformChange(varName: string, optionText: string) {
    const newSelections = { ...bodyformSelections, [varName]: optionText };
    setBodyformSelections(newSelections);
    persist({ bodyformSelections: newSelections });
  }

  function handleShowAuxLinesChange(checked: boolean) {
    setShowAuxLines(checked);
    persist({ showAuxLines: checked });
  }

  function handleShowPointsChange(checked: boolean) {
    setShowPoints(checked);
    persist({ showPoints: checked });
  }

  function handleShowAllowanceChange(checked: boolean) {
    setShowAllowance(checked);
    persist({ showAllowance: checked });
  }

  async function handleSave(filename: string) {
    if (!activeLoaded) return;
    const text = activeLoaded.text;
    const res = await fetch(`/api/parts/${filename}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? "Save failed");
    }
    setPartFiles((prev) =>
      prev.includes(filename) ? prev : [...prev, filename].sort()
    );
    // Update the active part: a "save as new file" renames it, and either way
    // its content is now the saved baseline. Drop any other entry that would
    // collide with the new file name so the list keeps one entry per file.
    const next = loadedParts
      .map((p) =>
        p.file === activePartFile ? { file: filename, text, savedText: text } : p
      )
      .filter((p, i, arr) => arr.findIndex((q) => q.file === p.file) === i);
    setLoadedParts(next);
    setActivePartFile(filename);
    setSaveModalOpen(false);
    persist({ loadedParts: next, activePartFile: filename });
  }

  // ── Pattern load / save ───────────────────────────────────────────────────

  // Load a saved pattern: fetch each referenced part fresh from disk and replay
  // the stored edit history. Replaces whatever is currently loaded.
  async function handleLoadPattern(name: string) {
    if (!name) return;
    let pattern: { parts?: string[]; edits?: PatternEdit[] };
    try {
      const res = await fetch(`/api/patterns/${name}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pattern = await res.json();
    } catch (err) {
      setPatternStatus({ ok: false, msg: `Failed to load pattern "${name}": ${(err as Error).message}` });
      return;
    }
    setPatternStatus(null);

    const files = pattern.parts ?? [];
    const parts: LoadedPart[] = await Promise.all(
      files.map(async (file) => {
        try {
          const res = await fetch(`/api/parts/${file}`, { cache: "no-store" });
          const raw = await res.text();
          const pretty = JSON.stringify(JSON.parse(raw), null, 2);
          return { file, text: pretty, savedText: pretty };
        } catch (err) {
          const msg = `// Failed to load ${file}: ${(err as Error).message}`;
          return { file, text: msg, savedText: msg };
        }
      })
    );
    // Older pattern files name cut pieces "part#A"; normalise to "part_1".
    const patternEdits = migrateEdits(pattern.edits ?? []);

    setLoadedParts(parts);
    setActivePartFile(parts[0]?.file ?? "");
    setEdits(patternEdits);
    setCurrentPatternName(name);
    setSelectedPlotPart(null);
    setHighlightedPart(null);
    setSavedPatternSig(patternSignature(files, patternEdits));
    persist({
      loadedParts: parts,
      activePartFile: parts[0]?.file ?? "",
      edits: patternEdits,
      currentPatternName: name,
    });
  }

  // Save the current combination (loaded parts + edit history) as a pattern file.
  async function handleSavePattern(name: string) {
    const files = loadedParts.map((p) => p.file);
    const body = { version: 1, parts: files, edits };
    const res = await fetch(`/api/patterns/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? "Save failed");
    }
    setPatternFiles((prev) => (prev.includes(name) ? prev : [...prev, name].sort()));
    setCurrentPatternName(name);
    setSavedPatternSig(patternSignature(files, edits));
    setSavePatternModalOpen(false);
    persist({ currentPatternName: name });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="app">
      <nav className="tab-strip">
        <button
          className={`tab-btn${activeTab === "measurements" ? " active" : ""}`}
          onClick={() => handleTabChange("measurements")}
          title="Measurements"
        >
          <span>Measurements</span>
        </button>
        <button
          className={`tab-btn${activeTab === "display" ? " active" : ""}`}
          onClick={() => handleTabChange("display")}
          title="Display"
        >
          <span>Display</span>
        </button>
        <button
          className={`tab-btn${activeTab === "pattern" ? " active" : ""}`}
          onClick={() => handleTabChange("pattern")}
          title="Pattern"
        >
          <span>Pattern</span>
        </button>
      </nav>

      <section className="panel left-panel">

        {activeTab === "measurements" && (
          <>
            <h1>cutavis · pattern prototype</h1>
            <p className="subtitle">
              Measurement formulas are evaluated with a safe math parser and drawn as SVG.
            </p>

            <h2>Measurement set</h2>
            <select
              className="set-select"
              value={selectedSet}
              onChange={(e) => handleSetChange(e.target.value)}
            >
              {measurementSetNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>

            <h2>Measurements</h2>
            {measurementVariableNames.map((name) => (
              <div className="field" key={name}>
                <label htmlFor={`m-${name}`}>{name}</label>
                <input
                  id={`m-${name}`}
                  type="number"
                  value={measurements[name] ?? 0}
                  onChange={(e) => handleMeasurementChange(name, Number(e.target.value))}
                />
                <select
                  className="field-set-select"
                  value={variableSets[name] ?? selectedSet}
                  onChange={(e) => handleVariableSetChange(name, e.target.value)}
                  title={`Load ${name} from set`}
                >
                  {measurementSetNames.map((setName) => (
                    <option key={setName} value={setName}>{setName}</option>
                  ))}
                </select>
              </div>
            ))}

            <h2>Body form</h2>
            {bodyformVariableNames.map((name) => (
              <div className="field" key={name}>
                <label htmlFor={`bf-${name}`}>{name}</label>
                <select
                  id={`bf-${name}`}
                  className="bodyform-select"
                  value={bodyformSelections[name] ?? bodyformVariables[name][0]?.text ?? ""}
                  onChange={(e) => handleBodyformChange(name, e.target.value)}
                  title={`Select ${name}`}
                >
                  {bodyformVariables[name].map((opt) => (
                    <option key={opt.text} value={opt.text}>{opt.text}</option>
                  ))}
                </select>
              </div>
            ))}

            {formulaErrors.length > 0 && (
              <div className="errors">
                Formula problems:
                <ul>
                  {formulaErrors.map(([key, msg]) => (
                    <li key={key}><code>{key}</code>: {msg}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="reload-csv">
              <button className="btn-secondary" onClick={handleReloadCsv}>
                Reload from CSV files
              </button>
              <p className="checkbox-note">
                Re-reads measurement_variables.csv and bodyform_variables.csv from disk and
                updates the fields and dropdowns above.
              </p>
              {reloadStatus && (
                <p className={reloadStatus.ok ? "reload-ok" : "reload-err"}>
                  {reloadStatus.msg}
                </p>
              )}
            </div>
          </>
        )}

        {saveModalOpen && (
          <SaveModal
            currentFile={activePartFile}
            onSave={handleSave}
            onClose={() => setSaveModalOpen(false)}
          />
        )}

        {printModalOpen && (
          <PrintModal
            pieces={plotPieces}
            options={printOptions}
            initial={printSettings}
            onCreate={handleCreatePdf}
            onClose={() => setPrintModalOpen(false)}
          />
        )}

        {addModalOpen && (
          <AddPartModal
            availableFiles={partFiles.filter(
              (f) => !loadedParts.some((p) => p.file === f)
            )}
            onAdd={handleAddPart}
            onClose={() => setAddModalOpen(false)}
          />
        )}

        {activeTab === "display" && (
          <div className="display-settings">
            <h1>Display</h1>
            <p className="subtitle">Control which elements are shown in the plot.</p>

            <h2>Lines</h2>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={showAuxLines}
                onChange={(e) => handleShowAuxLinesChange(e.target.checked)}
              />
              Show aux lines
            </label>

            <h2>Points</h2>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={showPoints}
                onChange={(e) => handleShowPointsChange(e.target.checked)}
              />
              Show points
              <span className="checkbox-note">(marker points are always visible)</span>
            </label>

            <h2>Seam allowance</h2>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={showAllowance}
                onChange={(e) => handleShowAllowanceChange(e.target.checked)}
              />
              Show seam allowance
              <span className="checkbox-note">
                (on the plot and in the PDF; seam 10 mm, mini-allowance-hem 7 mm, maxi-allowance-hem 4 cm — set per line with “Specify line”)
              </span>
            </label>
          </div>
        )}

        {activeTab === "pattern" && !patternEditMode && (
          <div className="pattern-tab">
            <h1>Pattern</h1>
            <p className="subtitle">
              A pattern is a set of parts loaded together plus the edits applied to them.
            </p>

            <h2>Load pattern</h2>
            <select
              className="set-select"
              value={currentPatternName}
              onChange={(e) => handleLoadPattern(e.target.value)}
            >
              <option value="">— select a pattern —</option>
              {patternFiles.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>

            <h2>Parts in this pattern:</h2>
            {loadedParts.length === 0 ? (
              <p className="subtitle">No parts loaded yet. Use “Edit pattern” to add parts.</p>
            ) : (
              <ul className="pattern-part-list">
                {loadedParts.map((p) => (
                  <li key={p.file}>
                    <button
                      className={`pattern-part-name${
                        p.file === highlightedPart ? " highlighted" : ""
                      }`}
                      onClick={() => handleHighlightPart(p.file)}
                      title="Highlight this part's lines on the plot"
                    >
                      {p.file}
                    </button>
                    {derivedPartsByFile[p.file]?.length > 0 && (
                      <ul className="derived-part-list">
                        {derivedPartsByFile[p.file].map((id) => (
                          <li key={id}>
                            <button
                              className={`pattern-part-name${
                                id === highlightedPart ? " highlighted" : ""
                              }`}
                              onClick={() => handleHighlightPart(id)}
                              title="Highlight this derived part on the plot"
                            >
                              {id}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="edit-part-actions">
              <button
                className="btn-secondary"
                onClick={enterPatternEdit}
                title="Edit the parts and JSON of this pattern"
              >
                Edit pattern
              </button>
            </div>

            <p className="checkbox-note">
              {edits.length} edit{edits.length === 1 ? "" : "s"} in history
              {currentPatternName && (
                <>
                  {" · "}
                  {patternDirty ? "unsaved changes" : `saved as “${currentPatternName}”`}
                </>
              )}
            </p>

            {patternStatus && !patternStatus.ok && (
              <p className="reload-err">{patternStatus.msg}</p>
            )}
          </div>
        )}

        {activeTab === "pattern" && patternEditMode && (
          <div className="pattern-tab edit-part-wrap">
            <div className="pattern-edit-head">
              <h1>Pattern · edit</h1>
              <button
                className="btn-secondary"
                onClick={exitPatternEdit}
                title="Return to the pattern overview"
              >
                ← Done
              </button>
            </div>

            <h2>Parts in this pattern:</h2>
            {loadedParts.length === 0 ? (
              <p className="subtitle">No parts loaded. Add a part to start editing.</p>
            ) : (
              <div className="field">
                <label htmlFor="edit-part-select">Editing part</label>
                <select
                  id="edit-part-select"
                  className="set-select"
                  value={activePartFile}
                  onChange={(e) => handleSelectPart(e.target.value)}
                >
                  {loadedParts.map((p) => {
                    const dirty = p.text !== p.savedText;
                    return (
                      <option key={p.file} value={p.file}>
                        {p.file}
                        {dirty ? " ●" : ""}
                      </option>
                    );
                  })}
                </select>
                {activePartFile !== "" && (
                  <button
                    className="loaded-part-remove"
                    onClick={() => handleRemovePart(activePartFile)}
                    title={`Remove ${activePartFile} from the plot`}
                    aria-label={`Remove ${activePartFile}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
            {activePartFile !== "" && derivedPartsByFile[activePartFile]?.length > 0 && (
              <div className="field">
                <label>Derived parts of {activePartFile} (click to select)</label>
                <ul className="pattern-part-list">
                  {derivedPartsByFile[activePartFile].map((id) => (
                    <li key={id}>
                      <button
                        className={`pattern-part-name${
                          id === selectedPlotPart ? " highlighted" : ""
                        }`}
                        onClick={() => handlePlotSelect(id === selectedPlotPart ? null : id)}
                        title="Select this part on the plot (move, rotate, cut, merge)"
                      >
                        {id}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button
              className="btn-add-part"
              onClick={() => setAddModalOpen(true)}
              title="Add a part to the plot"
            >
              + Add part
            </button>

            {activePartFile === "" ? (
              <p className="subtitle" style={{ marginTop: 16 }}>
                Add a part to start editing.
              </p>
            ) : (
              <>
                {activePart &&
                  Object.keys(activePart.part_specific_user_definable_variables ?? {}).length > 0 && (
                    <div className="customize-section">
                      <h2>Customize</h2>
                      {Object.entries(activePart.part_specific_user_definable_variables!).map(
                        ([name, value]) => (
                          <div className="field" key={name}>
                            <label htmlFor={`psv-${name}`}>
                              {name}
                              {varPartCounts[name] > 1 && (
                                <span
                                  className="shared-var-badge"
                                  title={`Shared by ${varPartCounts[name]} loaded parts — editing updates all of them`}
                                >
                                  shared ×{varPartCounts[name]}
                                </span>
                              )}
                            </label>
                            <input
                              id={`psv-${name}`}
                              type="number"
                              value={value}
                              onChange={(e) =>
                                handlePartVariableChange(name, Number(e.target.value))
                              }
                            />
                          </div>
                        )
                      )}
                    </div>
                  )}

                <h2>Part Definition (JSON) — {activePartFile}</h2>
                <textarea
                  className={`json-editor${activeParseError ? " invalid" : ""}`}
                  value={activeText}
                  spellCheck={false}
                  onChange={(e) => handlePartTextChange(e.target.value)}
                />
                {activeParseError && (
                  <div className="errors">
                    Invalid JSON: <code>{activeParseError}</code>
                  </div>
                )}

                <div className="edit-part-actions">
                  <button
                    className="btn-primary"
                    onClick={() => setSaveModalOpen(true)}
                    disabled={!isDirty}
                    title={isDirty ? "Save changes" : "No unsaved changes"}
                  >
                    Save
                  </button>
                </div>
              </>
            )}

            <hr className="edit-divider" />

            <p className="checkbox-note">
              {edits.length} edit{edits.length === 1 ? "" : "s"} in history
              {currentPatternName && (
                <>
                  {" · "}
                  {patternDirty ? "unsaved changes" : `saved as “${currentPatternName}”`}
                </>
              )}
            </p>

            <div className="edit-part-actions">
              <button
                className="btn-primary"
                onClick={() => setSavePatternModalOpen(true)}
                disabled={loadedParts.length === 0}
                title={loadedParts.length === 0 ? "Load parts first" : "Save this pattern"}
              >
                Save pattern
              </button>
            </div>

            {patternStatus && !patternStatus.ok && (
              <p className="reload-err">{patternStatus.msg}</p>
            )}
          </div>
        )}

        {savePatternModalOpen && (
          <SaveModal
            title="Save pattern"
            currentFile={currentPatternName}
            onSave={handleSavePattern}
            onClose={() => setSavePatternModalOpen(false)}
          />
        )}
      </section>

      <section className="panel plot-panel">
        <div className="plot-main">
          <div className="plot-toolbar">
            <span className="plot-toolbar-info">
              {cut
                ? cutInstruction
                : rotate
                ? rotateInstruction
                : merge
                ? mergeInstruction
                : specify
                ? specifyInstruction
                : smooth
                ? smoothInstruction
                : selectedPlotPart
                ? `Selected: ${selectedPlotPart} — drag on the plot to move it`
                : patternEditMode
                ? "Click a part on the plot to select it"
                : "Enter edit mode to modify the pattern"}
            </span>
            {patternEditMode && (merge || !toolBusy) && (
              <span className="merge-config" title="Merge tolerances: max angle and max length difference">
                <label>
                  ≤
                  <input
                    type="number" min={0} max={90} value={mergeAngle}
                    onChange={(e) => setMergeAngle(Number(e.target.value))}
                  />
                  °
                </label>
                <label>
                  ±
                  <input
                    type="number" min={0} max={100} value={mergeLenPct}
                    onChange={(e) => setMergeLenPct(Number(e.target.value))}
                  />
                  %
                </label>
              </span>
            )}
            {patternEditMode && !toolBusy && (
              <>
                <button
                  className="btn-secondary"
                  onClick={startCut}
                  disabled={!canCut}
                  title={
                    canCut
                      ? "Cut the selected part along a line"
                      : "Select a part with a closed outline to cut it"
                  }
                >
                  ✂ Cut
                </button>
                <button
                  className="btn-secondary"
                  onClick={startRotate}
                  disabled={!canRotate}
                  title={
                    canRotate
                      ? "Rotate the selected part around a point"
                      : "Select a part with a closed outline to rotate it"
                  }
                >
                  ↻ Rotate
                </button>
                <button
                  className="btn-secondary"
                  onClick={startMerge}
                  disabled={!canMerge}
                  title={canMerge ? "Merge two parts along a line" : "Load at least two parts to merge"}
                >
                  ⧉ Merge
                </button>
                <button
                  className="btn-secondary"
                  onClick={startSpecify}
                  disabled={!canSpecify}
                  title="Set a line's type (seam allowance) and merge marker"
                >
                  ✎ Specify line
                </button>
                <button
                  className="btn-secondary"
                  onClick={startSmooth}
                  disabled={!canSmooth}
                  title="Replace consecutive outline lines by one smooth curve"
                >
                  〰 Smooth
                </button>
              </>
            )}
            {smooth && (
              <>
                <button
                  className="btn-primary"
                  onClick={commitSmooth}
                  disabled={!smoothCurve}
                  title={smoothCurve ? "Replace the selected lines by the previewed curve" : "Select ≥ 2 consecutive lines first"}
                >
                  Smooth now
                </button>
                <button className="btn-secondary" onClick={() => setSmooth(null)} title="Cancel smoothing">
                  Abort smoothing
                </button>
              </>
            )}
            {specify && (
              <>
                {specify.sel && (
                  <>
                    <label className="specify-field">
                      Line type
                      <select
                        value={specify.allowance}
                        onChange={(e) =>
                          setSpecify((s) => (s ? { ...s, allowance: e.target.value as AllowanceType } : s))
                        }
                      >
                        {ALLOWANCE_TYPES.map((a) => (
                          <option key={a} value={a}>
                            {a} ({ALLOWANCE_MM[a] > 10 ? `${ALLOWANCE_MM[a] / 10} cm` : `${ALLOWANCE_MM[a]} mm`})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="specify-field">
                      Merge marker
                      <select
                        value={specify.marker ?? ""}
                        onChange={(e) =>
                          setSpecify((s) =>
                            s ? { ...s, marker: e.target.value === "" ? null : (e.target.value as MergeMarker) } : s
                          )
                        }
                      >
                        <option value="">— none —</option>
                        {MERGE_MARKERS.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                    <button className="btn-primary" onClick={applySpecify} title="Store this line specification">
                      Apply
                    </button>
                  </>
                )}
                <button className="btn-secondary" onClick={() => setSpecify(null)} title="Leave line specification">
                  Done
                </button>
              </>
            )}
            {merge && (
              <>
                {merge.sel && merge.cand && (
                  <>
                    <button className="btn-secondary" onClick={pullTogether} title="Move the parts together to align the lines">
                      Pull together
                    </button>
                    <button className="btn-primary" onClick={mergeNow} title="Merge the two parts into one">
                      Merge now
                    </button>
                  </>
                )}
                <button className="btn-secondary" onClick={abortMerge} title="Cancel the merge">
                  Abort merge
                </button>
              </>
            )}
            {cut && (
              <>
                <span className="cut-mode-switch" role="group" aria-label="Cut sub-mode">
                  <button
                    className={cut.mode === "draw" ? "active" : ""}
                    onClick={() => setCutMode("draw")}
                    title="Draw the cut line (start/end snap to marks)"
                  >
                    ✂ Cut line
                  </button>
                  <button
                    className={cut.mode === "measure" ? "active" : ""}
                    onClick={() => setCutMode("measure")}
                    title="Measure distances along the outline and mark points"
                  >
                    📏 Measure
                  </button>
                </span>
                {cut.marks.length > 0 && (
                  <button
                    className="btn-secondary"
                    onClick={clearCutMarks}
                    title="Remove all temporary marks"
                  >
                    Clear marks ({cut.marks.length})
                  </button>
                )}
                <button
                  className="btn-primary"
                  onClick={commitCut}
                  disabled={!cutValid}
                  title={cutValid ? "Split the part in two" : "Place two points that divide the part"}
                >
                  Cut now
                </button>
                <button className="btn-secondary" onClick={abortCut} title="Cancel this cut">
                  Abort cutting
                </button>
              </>
            )}
            {rotate && (
              <button className="btn-secondary" onClick={abortRotate} title="Cancel this rotation">
                Abort rotate
              </button>
            )}
            <button
              className="btn-secondary"
              onClick={handleUndo}
              disabled={edits.length === 0}
              title={edits.length === 0 ? "Nothing to undo" : "Undo last edit"}
            >
              ↶ Undo
            </button>
            <button
              className="btn-secondary"
              onClick={() => setPrintModalOpen(true)}
              disabled={plotPieces.length === 0}
              title={plotPieces.length === 0 ? "Load parts first" : "Print the pattern at 100 % scale to a PDF"}
            >
              🖨 Print to PDF
            </button>
          </div>
          <div className="canvas-wrap">
            {loadedParts.length === 0 ? (
              <div className="subtitle">Add a part to see the pattern.</div>
            ) : plotParts.length > 0 ? (
              <PatternSvg
                parts={plotParts}
                showAuxLines={showAuxLines}
                showPoints={showPoints}
                selectedPart={selectedPlotPart}
                highlightedPart={highlightedPart}
                editMode={patternEditMode}
                activePart={activePartFile}
                onSelectPart={handlePlotSelect}
                onMovePart={handleMovePart}
                cut={
                  cut
                    ? {
                        loop: cutLoop,
                        phase: cutPhase,
                        from: cut.from?.point ?? null,
                        to: cut.to?.point ?? null,
                        preview: cutPreview,
                        controls: cutControls,
                        mode: cut.mode,
                        marks: cut.marks.map((m) => m.point),
                        onAddMark: handleAddCutMark,
                        onPlace: handleCutPlace,
                        onMoveEnd: handleCutMoveEnd,
                        onMoveControl: handleCutMoveControl,
                      }
                    : null
                }
                rotate={
                  rotate
                    ? {
                        loop: rotateLoop,
                        partId: rotate.part,
                        center: rotate.center?.point ?? null,
                        onPickCenter: handleRotateCenter,
                        onCommit: handleRotateCommit,
                      }
                    : null
                }
                merge={
                  merge
                    ? { segments: mergeOverlaySegs, onPick: handleMergePick }
                    : specify
                    ? { segments: specifyOverlaySegs, onPick: handleSpecifyPick }
                    : smooth
                    ? { segments: smoothOverlaySegs, onPick: handleSmoothPick }
                    : null
                }
                allowances={allowanceByPiece}
              />
            ) : (
              <div className="subtitle">Fix the part JSON to see the pattern.</div>
            )}
          </div>
        </div>
        {loadedParts.length > 0 && <InspectorPanel geometry={merged} />}
      </section>
    </main>
  );
}
