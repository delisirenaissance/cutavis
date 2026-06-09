// Client-side persistence via localStorage (single key, single JSON object).
// All reads/writes go through loadState() / saveState() so there is no race
// between effects that read and effects that write on the same render.

import type { Measurements } from "./types";

type Tab = "measurements" | "edit-part" | "display";
type VariableSets = Record<string, string>;

export interface StoredState {
  activeTab?: Tab;
  partText?: string;
  /** Content at the last explicit file load or save — used to detect unsaved edits. */
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
