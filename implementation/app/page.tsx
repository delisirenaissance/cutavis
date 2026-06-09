"use client";

import { useEffect, useMemo, useState } from "react";
import { collectVariables, evaluatePart } from "@/lib/geometry";
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
import { PatternSvg } from "@/components/PatternSvg";
import { SaveModal } from "@/components/SaveModal";
import InspectorPanel from "@/components/InspectorPanel";

type Tab = "measurements" | "edit-part" | "display";
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
  const [partText, setPartText] = useState("");
  const [selectedPartFile, setSelectedPartFile] = useState(DEFAULT_PART_FILE);
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
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  // Tracks the content that was last loaded from or saved to disk
  const [savedPartText, setSavedPartText] = useState("");

  // ── Persistence: write a snapshot of all current state plus any overrides ──

  function persist(overrides: Partial<StoredState> = {}) {
    // Values from the closure are the current React state at call time.
    // Overrides carry new values that were just computed in the same handler
    // (since setState is asynchronous and the closure still holds old values).
    saveState({
      activeTab,
      partText,
      lastSavedPartText: savedPartText,
      selectedPartFile,
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

    // Restore persisted state
    const stored = loadState();

    if (stored.activeTab)                  setActiveTab(stored.activeTab);
    if (stored.selectedSet)                setSelectedSet(stored.selectedSet);
    if (stored.measurements)               setMeasurements(stored.measurements);
    if (stored.variableSets)               setVariableSets(stored.variableSets);
    if (stored.bodyformSelections)         setBodyformSelections({ ...defaultBodyformSelections(), ...stored.bodyformSelections });
    if (stored.showAuxLines !== undefined) setShowAuxLines(stored.showAuxLines);
    if (stored.showPoints   !== undefined) setShowPoints(stored.showPoints);

    const partFile = stored.selectedPartFile ?? DEFAULT_PART_FILE;
    setSelectedPartFile(partFile);

    // Validate that the stored partText uses the current object format for points
    // (not the old tuple format ["expr","expr"]). Old data would crash geometry.ts.
    const storedPartIsUsable = (() => {
      if (!stored.partText) return false;
      try {
        const p = JSON.parse(stored.partText);
        const first = Object.values(p.points ?? {})[0];
        return first == null || (!Array.isArray(first) && typeof first === "object");
      } catch {
        return false;
      }
    })();

    if (storedPartIsUsable) {
      setPartText(stored.partText!);
      setSavedPartText(stored.lastSavedPartText ?? stored.partText!);
    } else {
      // First visit, stale format, or invalid JSON — load fresh from disk
      fetch(`/api/parts/${partFile}`)
        .then((r) => r.text())
        .then((text) => {
          const pretty = JSON.stringify(JSON.parse(text), null, 2);
          setPartText(pretty);
          setSavedPartText(pretty);
          saveState({ ...stored, partText: pretty, lastSavedPartText: pretty, selectedPartFile: partFile });
        })
        .catch(() => {
          const fallback = JSON.stringify(samplePart, null, 2);
          setPartText(fallback);
          setSavedPartText(fallback);
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  // ── Geometry pipeline (derived, not persisted) ────────────────────────────

  const parsed = useMemo<{ part: PartDef | null; error: string | null }>(() => {
    try {
      return { part: JSON.parse(partText) as PartDef, error: null };
    } catch (err) {
      return { part: null, error: (err as Error).message };
    }
  }, [partText]);

  const part = parsed.part;
  const variables = useMemo(() => (part ? collectVariables(part) : []), [part]);

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

  // Scope passed to the geometry engine. We provide ALL known values (every
  // measurement + every body-form value + this part's user-definable variables)
  // rather than only the formula-detected subset, so that local_variables and
  // point formulas can reference any of them — even names that collide with
  // expr-eval built-ins (e.g. `length`), which the detector can't always see.
  // Part-specific variables take precedence over measurements on name clashes.
  // Any remaining detected-but-unknown name still defaults to 0 so partial edits
  // keep rendering.
  const scope = useMemo(() => {
    const s: Measurements = {
      ...variableValues,
      ...(part?.part_specific_user_definable_variables ?? {}),
    };
    for (const v of variables) if (!(v in s)) s[v] = 0;
    return s;
  }, [variables, variableValues, part]);

  const geometry = useMemo(
    () => (part ? evaluatePart(part, scope) : null),
    [part, scope]
  );

  const formulaErrors = geometry ? Object.entries(geometry.errors) : [];

  // Save button is enabled only when the editor content differs from the last
  // file load or save (i.e., there are unsaved changes).
  const isDirty = partText !== savedPartText;

  // ── Event handlers (each calls persist() with the new values) ─────────────

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    persist({ activeTab: tab });
  }

  function handlePartTextChange(text: string) {
    setPartText(text);
    persist({ partText: text });
  }

  // Edit a part_specific_user_definable_variable: write the new value straight
  // back into the JSON so the editor and the geometry stay in sync.
  function handlePartVariableChange(name: string, value: number) {
    if (!part) return;
    const updated: PartDef = {
      ...part,
      part_specific_user_definable_variables: {
        ...part.part_specific_user_definable_variables,
        [name]: value,
      },
    };
    const text = JSON.stringify(updated, null, 2);
    setPartText(text);
    persist({ partText: text });
  }

  async function handlePartFileChange(filename: string) {
    setSelectedPartFile(filename);
    persist({ selectedPartFile: filename });
    if (!filename) return;
    try {
      const res = await fetch(`/api/parts/${filename}`);
      const text = await res.text();
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      setPartText(pretty);
      setSavedPartText(pretty);
      persist({ selectedPartFile: filename, partText: pretty, lastSavedPartText: pretty });
    } catch (err) {
      const msg = `// Failed to load ${filename}: ${(err as Error).message}`;
      setPartText(msg);
      persist({ selectedPartFile: filename, partText: msg });
    }
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
    const res = await fetch(`/api/parts/${filename}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: partText,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? "Save failed");
    }
    setPartFiles((prev) =>
      prev.includes(filename) ? prev : [...prev, filename].sort()
    );
    setSelectedPartFile(filename);
    setSavedPartText(partText);
    setSaveModalOpen(false);
    persist({ selectedPartFile: filename, lastSavedPartText: partText });
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
          title="Edit Part Definition"
        >
          <span>Edit Part Definition</span>
        </button>
        <button
          className={`tab-btn${activeTab === "display" ? " active" : ""}`}
          onClick={() => handleTabChange("display")}
          title="Display"
        >
          <span>Display</span>
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
            <h2>Load part file</h2>
            <select
              className="set-select"
              value={selectedPartFile}
              onChange={(e) => handlePartFileChange(e.target.value)}
            >
              <option value="">— select a file —</option>
              {partFiles.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>

            {part && Object.keys(part.part_specific_user_definable_variables ?? {}).length > 0 && (
              <div className="customize-section">
                <h2>Customize</h2>
                {Object.entries(part.part_specific_user_definable_variables!).map(([name, value]) => (
                  <div className="field" key={name}>
                    <label htmlFor={`psv-${name}`}>{name}</label>
                    <input
                      id={`psv-${name}`}
                      type="number"
                      value={value}
                      onChange={(e) => handlePartVariableChange(name, Number(e.target.value))}
                    />
                  </div>
                ))}
              </div>
            )}

            <h2>Part Definition (JSON)</h2>
            <textarea
              className={`json-editor${parsed.error ? " invalid" : ""}`}
              value={partText}
              spellCheck={false}
              onChange={(e) => handlePartTextChange(e.target.value)}
            />
            {parsed.error && (
              <div className="errors">
                Invalid JSON: <code>{parsed.error}</code>
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
          </div>
        )}

        {saveModalOpen && (
          <SaveModal
            currentFile={selectedPartFile}
            onSave={handleSave}
            onClose={() => setSaveModalOpen(false)}
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
      </section>

      <section className="panel plot-panel">
        <div className="canvas-wrap">
          {geometry ? (
            <PatternSvg
              geometry={geometry}
              showAuxLines={showAuxLines}
              showPoints={showPoints}
            />
          ) : (
            <div className="subtitle">
              {partText ? "Fix the part JSON to see the pattern." : "Loading…"}
            </div>
          )}
        </div>
        {geometry && <InspectorPanel geometry={geometry} />}
      </section>
    </main>
  );
}
