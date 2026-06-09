// Parsers for the manually-maintained variable CSVs that live next to the
// project (measurement_variables.csv, bodyform_variables.csv).
//
// Format: semicolon-separated, a leading junk line ("\;\;"), then a header row,
// then data rows. Cells are trimmed (the source files contain stray trailing
// spaces in some labels).

import type { Measurements } from "./types";
import type { BodyformOption } from "./bodyformVariables";

export interface VariableTables {
  measurementVariableNames: string[];
  measurementSets: Record<string, Measurements>;
  bodyformVariables: Record<string, BodyformOption[]>;
}

function toRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(";").map((c) => c.trim()));
}

/**
 * Parse measurement_variables.csv:
 *   measurement_variable;<setName1>;<setName2>;…
 *   <varName>;<value1>;<value2>;…
 * Returns the variable names (in file order) and one Measurements map per set.
 */
export function parseMeasurementCsv(text: string): {
  measurementVariableNames: string[];
  measurementSets: Record<string, Measurements>;
} {
  const rows = toRows(text);
  const headerIdx = rows.findIndex((r) => r[0] === "measurement_variable");
  if (headerIdx === -1) {
    throw new Error('measurement_variables.csv: header row "measurement_variable;…" not found');
  }
  const setNames = rows[headerIdx].slice(1).map((s) => s.trim()).filter(Boolean);
  if (setNames.length === 0) {
    throw new Error("measurement_variables.csv: no measurement-set columns in header");
  }

  const measurementSets: Record<string, Measurements> = {};
  for (const s of setNames) measurementSets[s] = {};
  const measurementVariableNames: string[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const varName = row[0];
    if (!varName) continue; // skip blank lines
    measurementVariableNames.push(varName);
    setNames.forEach((setName, col) => {
      const n = Number(row[col + 1]);
      measurementSets[setName][varName] = Number.isFinite(n) ? n : 0;
    });
  }
  return { measurementVariableNames, measurementSets };
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
