// Body-form variables — transcribed from ../../bodyform_variables.csv.
//
// Unlike measurement variables, these do NOT depend on the selected
// measurement set. Instead the user picks a human-readable option from a
// dropdown (dropdown_text) and the app silently maps it to an internal numeric
// value (dropdown_value) bound to the dropdown_variable name. That value is
// then available to point formulas in the part JSON, e.g. a formula may
// reference `torsolength` directly.

export interface BodyformOption {
  /** Human-readable label shown in the dropdown (CSV column 2). */
  text: string;
  /** Internal numeric value bound to the variable when selected (CSV column 3). */
  value: number;
}

/**
 * Options per body-form variable, in CSV order. The first entry of each list
 * is used as the default selection.
 */
export const BODYFORM_VARIABLES: Record<string, BodyformOption[]> = {
  waistform: [
    { text: "none of the others", value: 1 },
    { text: "a bit flatter buttocks, PLUS a bit stronger hips", value: 0.5 },
    { text: "very flat buttocks, PLUS very strong hips", value: 0 },
    { text: "a bit stronger buttocks, PLUS a bit flater hips", value: 1.5 },
    { text: "very strong buttocks, PLUS quite flat hips", value: 2 },
  ],
  cupsize: [
    { text: "C", value: 0.8 },
    { text: "A", value: 0 },
    { text: "B", value: 0.4 },
    { text: "D", value: 1.2 },
    { text: "E", value: 1.6 },
    { text: "F", value: 2 },
    { text: "G", value: 2.4 },
    { text: "H", value: 2.8 },
  ],
  torsolength: [
    { text: "regular", value: 1 },
    { text: "a bit shorter torso", value: 0.5 },
    { text: "exceptionally short torso", value: 0 },
    { text: "a bit longer torso", value: 1.5 },
    { text: "exceptionally long torso", value: 2 },
  ],
};

/** Variable names, in CSV order: ["waistform", "cupsize", "torsolength"]. */
export const BODYFORM_VARIABLE_NAMES = Object.keys(BODYFORM_VARIABLES);

export type BodyformTable = Record<string, BodyformOption[]>;

/** The default selected option text for each variable (first option in CSV order). */
export function defaultBodyformSelections(
  table: BodyformTable = BODYFORM_VARIABLES
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(table).map((name) => [name, table[name][0]?.text ?? ""])
  );
}

/** Resolve a selection map (variable → chosen text) to numeric values. */
export function resolveBodyformValues(
  selections: Record<string, string>,
  table: BodyformTable = BODYFORM_VARIABLES
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const name of Object.keys(table)) {
    const options = table[name];
    if (!options || options.length === 0) continue;
    const chosenText = selections[name];
    const opt = options.find((o) => o.text === chosenText) ?? options[0];
    values[name] = opt.value;
  }
  return values;
}
