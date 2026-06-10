// Client-side persistence via localStorage (single key, single JSON object).
// All reads/writes go through loadState() / saveState() so there is no race
// between effects that read and effects that write on the same render.

import type { Measurements } from "./types";
import type { PatternEdit } from "./edits";

type Tab = "measurements" | "edit-part" | "display" | "pattern";
type VariableSets = Record<string, string>;

/** One pattern part loaded into the editor / plot. */
export interface StoredLoadedPart {
  /** Source file name (without .json) — also used as the part's id. */
  file: string;
  /** Current editor content. */
  text: string;
  /** Content at the last explicit file load or save — used to detect unsaved edits. */
  savedText: string;
}

export interface StoredState {
  activeTab?: Tab;
  /** All parts currently loaded onto the plot. */
  loadedParts?: StoredLoadedPart[];
  /** File name of the part currently shown in the editor. */
  activePartFile?: string;
  /** Ordered edit history applied to the loaded parts (moves, future splits). */
  edits?: PatternEdit[];
  /** Name of the pattern file the loaded combination was last loaded/saved as. */
  currentPatternName?: string;

  // ── Deprecated single-part fields (read only, for migrating old storage) ──
  partText?: string;
  lastSavedPartText?: string;
  selectedPartFile?: string;

  selectedSet?: string;
  measurements?: Measurements;
  variableSets?: VariableSets;
  /** Body-form dropdown choices: variable name → selected option text. */
  bodyformSelections?: Record<string, string>;
  showAuxLines?: boolean;
  showPoints?: boolean;
}

const KEY = "cutavis";

export function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredState) : {};
  } catch {
    return {};
  }
}

export function saveState(state: StoredState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage unavailable — fail silently.
  }
}
