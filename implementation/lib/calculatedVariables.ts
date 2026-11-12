// Calculated variables: named values derived from the measurements by Excel
// style formulas (calculated_variables.csv), e.g.
//
//   ArD;"BrU/8 + if(BrU<90;-1.5;if(BrU<100;-1.0;0))"
//
// They are evaluated against the measurements and body-form values and then
// behave exactly like measurements in every part formula (points, lines,
// local variables, conditions, defined parts).

import { Parser } from "expr-eval";

export interface CalculatedVariable {
  name: string;
  /** The formula as written in the CSV (Excel syntax). */
  formula: string;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Split text into rows of cells: `;`-separated, cells may be "quoted" (so the
 *  formulas can contain `;` — Excel's argument separator — and the file's own
 *  column separator at the same time), with `""` as an escaped quote. */
function parseQuotedRows(text: string, sep = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

/** Parse calculated_variables.csv: a `calculated_variable;formula` header row,
 *  then one row per variable. Rows without a name or formula are skipped. */
export function parseCalculatedCsv(text: string): CalculatedVariable[] {
  const rows = parseQuotedRows(text);
  const headerIdx = rows.findIndex((r) => r[0] === "calculated_variable");
  if (headerIdx === -1) {
    throw new Error('calculated_variables.csv: header row "calculated_variable;formula" not found');
  }
  const out: CalculatedVariable[] = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const name = row[0];
    const formula = row[1];
    if (!name || !formula) continue;
    out.push({ name, formula });
  }
  return out;
}

// ── Excel → expr-eval ────────────────────────────────────────────────────────

/** Split a function's argument text at top-level `;` / `,`. */
function splitArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && (ch === ";" || ch === ",")) { args.push(cur); cur = ""; }
    else cur += ch;
  }
  args.push(cur);
  return args;
}

/** Rewrite AND(a;b;…) / OR(…) / NOT(x), which expr-eval has as operators only.
 *  The rewritten text uses marker tokens (`@AND@` …): the plain words `and (`
 *  / `not (` would match the search pattern again and be rewritten forever. */
function convertLogicFunctions(expr: string): string {
  const re = /\b(AND|OR|NOT)\s*\(/i;
  for (let guard = 0; guard < 500; guard++) {
    const m = re.exec(expr);
    if (!m) return expr.replace(/@AND@/g, " and ").replace(/@OR@/g, " or ").replace(/@NOT@/g, " not ");
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < expr.length; i++) {
      if (expr[i] === "(") depth++;
      else if (expr[i] === ")" && --depth === 0) { close = i; break; }
    }
    if (close < 0) throw new Error("Unbalanced parentheses");
    const args = splitArgs(expr.slice(open + 1, close));
    const fn = m[1].toLowerCase();
    let rep: string;
    if (fn === "not") {
      if (args.length !== 1) throw new Error("NOT takes exactly one argument");
      rep = `(@NOT@ (${args[0]}))`;
    } else {
      rep = "(" + args.map((a) => `(${a})`).join(fn === "and" ? "@AND@" : "@OR@") + ")";
    }
    expr = expr.slice(0, m.index) + rep + expr.slice(close + 1);
  }
  throw new Error("Formula too deeply nested");
}

// ── Simple arithmetic ────────────────────────────────────────────────────────

/** Only variable names, numbers, + - * / ( ) and spaces — and no function call
 *  (a name directly followed by "("). Decimal commas are allowed. */
const ARITHMETIC_CHARS_RE = /^[\sA-Za-z_0-9.,+\-*/()]*$/;
const FUNCTION_CALL_RE = /[A-Za-z_][A-Za-z_0-9]*\s*\(/;

/** Is the formula (without a leading "=") plain arithmetic over variables and
 *  numbers, e.g. "BrU/4 + AlT*0,5 - (TaU - 2)"? */
export function isSimpleArithmetic(formula: string): boolean {
  const s = formula.trim().replace(/^=\s*/, "");
  return s !== "" && ARITHMETIC_CHARS_RE.test(s) && !FUNCTION_CALL_RE.test(s);
}

/** A simple arithmetic formula as expr-eval text. Such a formula has no
 *  argument lists, so a comma between digits can only be a decimal comma (as
 *  written by a German Excel / LibreOffice): "0,5" → "0.5". Any other comma
 *  is an error. The result is evaluated "as it is" — by expr-eval, never by
 *  JavaScript eval(), so file content can't run code. */
function arithmeticToExpr(formula: string): string {
  const s = formula.trim().replace(/^=\s*/, "").replace(/(\d),(\d)/g, "$1.$2");
  if (s.includes(",")) throw new Error(`Unexpected "," in "${formula.trim()}" (decimal comma between digits only)`);
  return s;
}

/**
 * Translate an Excel-style formula to the expr-eval syntax:
 *  - simple arithmetic (variables, numbers, + - * / ( )) is taken as it is,
 *    with decimal commas allowed ("BrU*0,5"),
 *  - a leading "=" is dropped,
 *  - IF(c; a; b) → if(c, a, b) (any case; nesting works as is),
 *  - ";" argument separators → ",",
 *  - "<>" → "!=", and a single "=" (equality) → "==",
 *  - AND/OR/NOT(...) → and / or / not operators.
 * Outside simple arithmetic, numbers must use "." as the decimal separator.
 */
export function excelToExpr(formula: string): string {
  if (isSimpleArithmetic(formula)) return arithmeticToExpr(formula);
  let s = formula.trim().replace(/^=\s*/, "");
  s = convertLogicFunctions(s);
  s = s.replace(/\bIF\s*\(/gi, "if(");
  s = s.replace(/;/g, ",");
  s = s.replace(/<>/g, "!=");
  s = s.replace(/<=|>=|!=|==|=/g, (m) => (m === "=" ? "==" : m));
  return s;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

const OP_BUCKETS = ["unaryOps", "binaryOps", "ternaryOps", "functions", "consts"] as const;

/** expr-eval parser without the built-ins that share a name with a variable
 *  (e.g. a measurement called `length`), so user variable names always win —
 *  the same rule as for part formulas. */
function parserWithout(names: Iterable<string>): Parser {
  const parser = new Parser();
  for (const bucket of OP_BUCKETS) {
    const table = (parser as unknown as Record<string, Record<string, unknown>>)[bucket];
    for (const name of names) delete table[name];
  }
  return parser;
}

export interface CalculatedResult {
  /** Successfully calculated values by variable name. */
  values: Record<string, number>;
  /** Problems by variable name (those variables are left out of `values`). */
  errors: Record<string, string>;
}

/**
 * Evaluate the calculated variables against `base` (measurements + body-form
 * values). A formula may also use other calculated variables: they are
 * resolved in dependency order. A variable that clashes with a base name, has
 * an unknown reference, a circular reference or an invalid formula gets an
 * entry in `errors` and no value.
 */
export function evaluateCalculated(defs: CalculatedVariable[], base: Record<string, number>): CalculatedResult {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const scope: Record<string, number> = { ...base };
  const parser = parserWithout([...Object.keys(base), ...defs.map((d) => d.name)]);

  const pending = new Map<string, { expr: ReturnType<Parser["parse"]>; vars: string[] }>();
  for (const d of defs) {
    if (d.name in base) {
      errors[d.name] = `"${d.name}" is already a measurement or body-form variable`;
      continue;
    }
    try {
      const expr = parser.parse(excelToExpr(d.formula));
      pending.set(d.name, { expr, vars: expr.variables() });
    } catch (err) {
      errors[d.name] = `Invalid formula: ${(err as Error).message}`;
    }
  }

  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const [name, p] of [...pending.entries()]) {
      const missing = p.vars.filter((v) => !(v in scope));
      if (missing.some((v) => pending.has(v) && v !== name)) continue; // waits for a dependency
      pending.delete(name);
      progress = true;
      if (missing.length > 0) {
        errors[name] = `Unknown variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`;
        continue;
      }
      try {
        const v = p.expr.evaluate(scope);
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`result is not a finite number (got ${v})`);
        scope[name] = v;
        values[name] = v;
      } catch (err) {
        errors[name] = `Cannot evaluate: ${(err as Error).message}`;
      }
    }
  }
  for (const name of pending.keys()) errors[name] = "Circular reference between calculated variables";
  return { values, errors };
}
