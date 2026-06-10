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
import type { Measurements, PartDef } from "@/lib/types";
import {
  applyEditsToGeometry,
  patternSignature,
  type PatternEdit,
} from "@/lib/edits";
import { PatternSvg } from "@/components/PatternSvg";
import { SaveModal } from "@/components/SaveModal";
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

type Tab = "measurements" | "edit-part" | "display" | "pattern";
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

  // Ephemeral UI state — not persisted
  const [partFiles, setPartFiles] = useState<string[]>([]);
  const [patternFiles, setPatternFiles] = useState<string[]>([]);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [savePatternModalOpen, setSavePatternModalOpen] = useState(false);
  // The part currently selected on the plot (highlighted, movable). Independent
  // of activePartFile so clearing the plot selection never empties the editor.
  const [selectedPlotPart, setSelectedPlotPart] = useState<string | null>(null);
  // Signature of the pattern as last loaded/saved — used to detect changes.
  const [savedPatternSig, setSavedPatternSig] = useState<string | null>(null);
  const [patternStatus, setPatternStatus] = useState<{ ok: boolean; msg: string } | null>(null);

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

    if (stored.activeTab)                  setActiveTab(stored.activeTab);
    if (stored.edits)                      setEdits(stored.edits);
    if (stored.currentPatternName) {
      setCurrentPatternName(stored.currentPatternName);
    }
    if (stored.selectedSet)                setSelectedSet(stored.selectedSet);
    if (stored.measurements)               setMeasurements(stored.measurements);
    if (stored.variableSets)               setVariableSets(stored.variableSets);
    if (stored.bodyformSelections)         setBodyformSelections({ ...defaultBodyformSelections(), ...stored.bodyformSelections });
    if (stored.showAuxLines !== undefined) setShowAuxLines(stored.showAuxLines);
    if (stored.showPoints   !== undefined) setShowPoints(stored.showPoints);

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
  const partGeometries = useMemo(() => {
    return loadedParts.map((lp) => {
      let part: PartDef | null = null;
      let parseError: string | null = null;
      try {
        part = JSON.parse(lp.text) as PartDef;
      } catch (err) {
        parseError = (err as Error).message;
      }
      let geometry: GeometryResult | null = null;
      if (part) {
        const s: Measurements = {
          ...variableValues,
          ...(part.part_specific_user_definable_variables ?? {}),
        };
        for (const v of collectVariables(part)) if (!(v in s)) s[v] = 0;
        // Evaluate the base geometry, then replay this part's edit history on
        // top of it (so moves/splits survive measurement changes).
        const base = evaluatePart(part, s);
        const partEdits = edits.filter((e) => e.part === lp.file);
        geometry = partEdits.length ? applyEditsToGeometry(base, partEdits) : base;
      }
      return { file: lp.file, part, parseError, geometry };
    });
  }, [loadedParts, variableValues, edits]);

  // Merge all parts' geometry into one result drawn on a shared plot.
  const merged = useMemo(
    () => mergeGeometries(partGeometries.map((p) => ({ id: p.file, geometry: p.geometry }))),
    [partGeometries]
  );

  // The part currently shown in the editor.
  const activeEntry = partGeometries.find((p) => p.file === activePartFile) ?? null;
  const activeLoaded = loadedParts.find((p) => p.file === activePartFile) ?? null;
  const activePart = activeEntry?.part ?? null;
  const activeParseError = activeEntry?.parseError ?? null;
  const activeText = activeLoaded?.text ?? "";

  // How many loaded parts define each user-definable variable name. Used to flag
  // variables that are shared across parts (an edit applies to all of them).
  const varPartCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const pg of partGeometries) {
      for (const k of Object.keys(pg.part?.part_specific_user_definable_variables ?? {})) {
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    return counts;
  }, [partGeometries]);

  const formulaErrors = Object.entries(merged.errors);

  // Save button is enabled only when the active part's editor content differs
  // from the last file load or save (i.e., there are unsaved changes).
  const isDirty = activeLoaded != null && activeLoaded.text !== activeLoaded.savedText;

  // Per-part geometries (edits already applied) for the plot's selectable groups.
  const plotParts = useMemo(
    () =>
      partGeometries
        .filter((p) => p.geometry)
        .map((p) => ({ id: p.file, geometry: p.geometry! })),
    [partGeometries]
  );

  // The current pattern (loaded parts + edits) differs from the last save?
  const currentPatternSig = patternSignature(loadedParts.map((p) => p.file), edits);
  const patternDirty = savedPatternSig != null && currentPatternSig !== savedPatternSig;

  // ── Event handlers (each calls persist() with the new values) ─────────────

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    persist({ activeTab: tab });
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
    const nextEdits = edits.filter((e) => e.part !== filename);
    setLoadedParts(next);
    setActivePartFile(active);
    setEdits(nextEdits);
    if (selectedPlotPart === filename) setSelectedPlotPart(null);
    persist({ loadedParts: next, activePartFile: active, edits: nextEdits });
  }

  // ── Plot interaction: select / move / undo ────────────────────────────────

  // Select a part on the plot. Also make it the editor's active part so the two
  // views stay in sync; clearing the plot selection leaves the editor untouched.
  function handlePlotSelect(id: string | null) {
    setSelectedPlotPart(id);
    if (id) {
      setActivePartFile(id);
      persist({ activePartFile: id });
    }
  }

  // Commit a drag as one undoable translate edit.
  function handleMovePart(id: string, dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    const nextEdits: PatternEdit[] = [...edits, { type: "translate", part: id, dx, dy }];
    setEdits(nextEdits);
    persist({ edits: nextEdits });
  }

  // Undo the most recent edit in the history.
  function handleUndo() {
    if (edits.length === 0) return;
    const nextEdits = edits.slice(0, -1);
    setEdits(nextEdits);
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
    const patternEdits = pattern.edits ?? [];

    setLoadedParts(parts);
    setActivePartFile(parts[0]?.file ?? "");
    setEdits(patternEdits);
    setCurrentPatternName(name);
    setSelectedPlotPart(null);
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
          className={`tab-btn${activeTab === "edit-part" ? " active" : ""}`}
          onClick={() => handleTabChange("edit-part")}
          title="Edit Pattern"
        >
          <span>Edit Pattern</span>
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

        {activeTab === "edit-part" && (
          <div className="edit-part-wrap">
            <h2>Loaded parts</h2>
            <ul className="loaded-parts">
              {loadedParts.length === 0 && (
                <li className="loaded-part-empty">No parts loaded.</li>
              )}
              {loadedParts.map((p) => {
                const dirty = p.text !== p.savedText;
                return (
                  <li
                    key={p.file}
                    className={`loaded-part${p.file === activePartFile ? " active" : ""}`}
                  >
                    <button
                      className="loaded-part-name"
                      onClick={() => handleSelectPart(p.file)}
                      title="Edit this part"
                    >
                      {p.file}
                      {dirty && <span className="loaded-part-dirty" title="Unsaved changes"> ●</span>}
                    </button>
                    <button
                      className="loaded-part-remove"
                      onClick={() => handleRemovePart(p.file)}
                      title={`Remove ${p.file} from the plot`}
                      aria-label={`Remove ${p.file}`}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
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
          </div>
        )}

        {saveModalOpen && (
          <SaveModal
            currentFile={activePartFile}
            onSave={handleSave}
            onClose={() => setSaveModalOpen(false)}
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
          </div>
        )}

        {activeTab === "pattern" && (
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

            <h2>This pattern</h2>
            {loadedParts.length === 0 ? (
              <p className="subtitle">No parts loaded yet. Add parts in the Edit Pattern tab.</p>
            ) : (
              <ul className="pattern-part-list">
                {loadedParts.map((p) => (
                  <li key={p.file}>{p.file}</li>
                ))}
              </ul>
            )}
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
              {selectedPlotPart
                ? `Selected: ${selectedPlotPart} — drag on the plot to move it`
                : "Click a part on the plot to select it"}
            </span>
            <button
              className="btn-secondary"
              onClick={handleUndo}
              disabled={edits.length === 0}
              title={edits.length === 0 ? "Nothing to undo" : "Undo last edit"}
            >
              ↶ Undo
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
                onSelectPart={handlePlotSelect}
                onMovePart={handleMovePart}
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
