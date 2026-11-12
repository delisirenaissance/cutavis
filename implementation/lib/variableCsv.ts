// Parsers for the manually-maintained variable CSVs that live next to the
// project (measurement_variables.csv, bodyform_variables.csv).
//
// Format: semicolon-separated, optional leading junk lines (";;"), then header
// row(s), then data rows. Cells are trimmed (the source files contain stray trailing
// spaces in some labels).

import type { Measurements } from "./types";
import type { BodyformOption } from "./bodyformVariables";
import type { CalculatedVariable } from "./calculatedVariables";

export interface VariableTables {
  measurementVariableNames: string[];
  measurementSets: Record<string, Measurements>;
  bodyformVariables: Record<string, BodyformOption[]>;
  /** Formula-defined variables (calculated_variables.csv); [] if the file is absent. */
  calculatedVariables: CalculatedVariable[];
  /** The size types (International, European, …) labelling the measurement sets. */
  sizeSystems: SizeSystem[];
}

/** One size type of measurement_variables.csv, e.g. "International sizes":
 *  the label of every measurement set (by set key) in that type, e.g. "M". */
export interface SizeSystem {
  name: string;
  labels: Record<string, string>;
}

/** A header row of measurement_variables.csv: "<Size type>:;<label>;…" or the
 *  older single header "measurement_variable;<label>;…". */
function isMeasurementHeader(row: string[]): boolean {
  return row[0] === "measurement_variable" || /:\s*$/.test(row[0] ?? "");
}

function toRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(";").map((c) => c.trim()));
}

/**
 * Parse measurement_variables.csv. One header row per size type, then the
 * data rows (one column per size):
 *   International sizes:;M;L
 *   European sizes:;38 (EU);40 (EU)
 *   <varName>;<value1>;<value2>;…
 * The older single header "measurement_variable;38 (EU);40 (EU)" still works
 * (one size type "Sizes").
 * A set is keyed by its label in the LAST header row (e.g. "38 (EU)"), so the
 * keys stay what they were with the single header (stored selections, PDFs).
 * Returns the variable names (in file order), one Measurements map per set and
 * the size types with every set's label.
 */
export function parseMeasurementCsv(text: string): {
  measurementVariableNames: string[];
  measurementSets: Record<string, Measurements>;
  sizeSystems: SizeSystem[];
} {
  const rows = toRows(text);
  const first = rows.findIndex(isMeasurementHeader);
  if (first === -1) {
    throw new Error(
      'measurement_variables.csv: no header row found ("International sizes:;M;L…" or "measurement_variable;…")'
    );
  }
  let end = first;
  while (end < rows.length && isMeasurementHeader(rows[end])) end++;
  const headers = rows.slice(first, end);

  // Column j's key: its label in the last header row, else in any other row.
  const columns = Math.max(...headers.map((h) => h.length)) - 1;
  const keys: string[] = [];
  for (let j = 1; j <= columns; j++) {
    const key = [...headers].reverse().map((h) => h[j] ?? "").find((l) => l !== "") ?? "";
    keys.push(key);
  }
  if (keys.every((k) => k === "")) {
    throw new Error("measurement_variables.csv: no measurement-set columns in header");
  }

  const sizeSystems: SizeSystem[] = headers.map((h) => {
    const labels: Record<string, string> = {};
    keys.forEach((key, i) => {
      if (key) labels[key] = h[i + 1] || key;
    });
    const name = h[0] === "measurement_variable" ? "Sizes" : h[0].replace(/:\s*$/, "").trim();
    return { name, labels };
  });

  const measurementSets: Record<string, Measurements> = {};
  for (const k of keys) if (k) measurementSets[k] = {};
  const measurementVariableNames: string[] = [];

  for (let i = end; i < rows.length; i++) {
    const row = rows[i];
    const varName = row[0];
    if (!varName) continue; // skip blank lines
    measurementVariableNames.push(varName);
    keys.forEach((key, col) => {
      if (!key) return;
      const n = Number(row[col + 1]);
      measurementSets[key][varName] = Number.isFinite(n) ? n : 0;
    });
  }
  return { measurementVariableNames, measurementSets, sizeSystems };
}

/**
 * Parse bodyform_variables.csv:
 *   dropdown_variable;dropdown_text;dropdown_value
 *   <variable>;<label>;<value>
 * Returns options grouped by variable, in file order.
 */
export function parseBodyformCsv(text: string): Record<string, BodyformOption[]> {
  const rows = toRows(text);
  const headerIdx = rows.findIndex((r) => r[0] === "dropdown_variable");
  if (headerIdx === -1) {
    throw new Error('bodyform_variables.csv: header row "dropdown_variable;…" not found');
  }

  const out: Record<string, BodyformOption[]> = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const variable = row[0];
    if (!variable) continue; // skip blank lines
    const text = row[1] ?? "";
    const value = Number(row[2]);
    (out[variable] ??= []).push({ text, value: Number.isFinite(value) ? value : 0 });
  }
  return out;
}
