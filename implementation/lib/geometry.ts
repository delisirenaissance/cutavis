// Geometry engine: evaluates point formulas against a measurement set and
// turns the resolved geometry into SVG path data.
//
// Formulas are parsed with expr-eval (a safe math parser) — we never call
// eval() / Function() on user input, per the architecture note.
//
// Formulas may also reference already-resolved sibling points using the syntax
//   point(NAME->x)  or  point(NAME->y)
// These are substituted with the resolved numeric value before expr-eval runs.
// Points are evaluated in dependency order (topological sort); circular
// references are detected and reported as errors.

import { Parser } from "expr-eval";
import type { Measurements, PartDef } from "./types";

const detectParser = new Parser();

const OP_BUCKETS = ["unaryOps", "binaryOps", "ternaryOps", "functions", "consts"] as const;

function makeParser(variableNames: Iterable<string>): Parser {
  const parser = new Parser();
  for (const bucket of OP_BUCKETS) {
    const table = (parser as unknown as Record<string, Record<string, unknown>>)[bucket];
    for (const name of variableNames) delete table[name];
  }
  return parser;
}

export interface ResolvedPoint {
  x: number;
  y: number;
  pointType?: string;
  position?: string;
}

export interface GeometryResult {
  points: Record<string, ResolvedPoint>;
  /** SVG path "d" strings, keyed by line name. */
  paths: Record<string, string>;
  /** lineType for each line, keyed by line name — used for rendering decisions. */
  lineTypes: Record<string, string | undefined>;
  /** Evaluated local_variables (name → numeric value). Exposed for debugging. */
  localValues: Record<string, number>;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  errors: Record<string, string>;
}

// ── Geometric function helpers ────────────────────────────────────────────────
// Points can declare "x&y": "f:funcName(arg1,arg2,...)" to compute both
// coordinates at once using a named geometric operation.

// The argument list may itself contain parentheses — arithmetic groupings or
// `point(NAME->x)` cross-references — so capture everything up to the final ")".
const GEO_FUNC_RE = /^f:(\w+)\((.*)\)$/;

function parseGeoFunc(expr: string): { func: string; args: string[] } | null {
  const m = GEO_FUNC_RE.exec(expr.trim());
  if (!m) return null;
  return { func: m[1], args: m[2].split(",").map((s) => s.trim()).filter(Boolean) };
}

/** Returns the unique point names referenced by a named line. */
function linePointDeps(lineName: string, part: PartDef): string[] {
  const line = part.lines[lineName];
  if (!line) return [];
  return [...new Set(line.linePointReferences)];
}

// ── Cubic Bézier intersection ──────────────────────────────────────────────
// A "line" in this model is a cubic Bézier defined by four control points
// [P0, C1, C2, P3]. A straight segment is the degenerate case where the
// controls lie on the chord (e.g. [A, A, B, B]). Intersecting two curves
// therefore requires a curve-aware method, NOT intersecting the P0→P3 chords.
//
// We use recursive de-Casteljau subdivision with axis-aligned bounding-box
// rejection: if two sub-curves' boxes don't overlap they can't cross; once a
// pair's boxes are smaller than the tolerance we've localised a crossing.
// This converges geometrically and naturally handles straight ↔ curved,
// curved ↔ curved, and degenerate cases alike.

type Vec2 = { x: number; y: number };
type Bezier = [Vec2, Vec2, Vec2, Vec2];

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Split a cubic Bézier at t = 0.5 into its left and right halves. */
function splitBezier(b: Bezier): [Bezier, Bezier] {
  const p01 = mid(b[0], b[1]);
  const p12 = mid(b[1], b[2]);
  const p23 = mid(b[2], b[3]);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  return [
    [b[0], p01, p012, p0123],
    [p0123, p123, p23, b[3]],
  ];
}

interface Box { minX: number; minY: number; maxX: number; maxY: number }

function bezierBox(b: Bezier): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of b) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

const boxesOverlap = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

const boxSize = (b: Box): number => Math.max(b.maxX - b.minX, b.maxY - b.minY);

/**
 * Find every point where two cubic Béziers cross, via recursive subdivision.
 * `tol` is the positional tolerance in geometry units. Returned points are
 * de-duplicated so a single crossing yields a single point.
 */
function intersectBeziers(a: Bezier, b: Bezier, tol = 1e-6): Vec2[] {
  const hits: Vec2[] = [];

  const recurse = (c1: Bezier, c2: Bezier, depth: number): void => {
    const box1 = bezierBox(c1);
    const box2 = bezierBox(c2);
    if (!boxesOverlap(box1, box2)) return;

    const s1 = boxSize(box1);
    const s2 = boxSize(box2);

    // Converged: both boxes are tiny (or we've recursed deep enough). The
    // crossing is the centre of the overlapping region.
    if ((s1 < tol && s2 < tol) || depth >= 60) {
      hits.push({
        x: (Math.max(box1.minX, box2.minX) + Math.min(box1.maxX, box2.maxX)) / 2,
        y: (Math.max(box1.minY, box2.minY) + Math.min(box1.maxY, box2.maxY)) / 2,
      });
      return;
    }

    // Subdivide the larger curve to keep the box sizes balanced.
    if (s1 >= s2) {
      const [l, r] = splitBezier(c1);
      recurse(l, c2, depth + 1);
      recurse(r, c2, depth + 1);
    } else {
      const [l, r] = splitBezier(c2);
      recurse(c1, l, depth + 1);
      recurse(c1, r, depth + 1);
    }
  };

  recurse(a, b, 0);

  // De-duplicate crossings that converged to the same location.
  const eps = tol * 100;
  const unique: Vec2[] = [];
  for (const h of hits) {
    if (!unique.some((u) => Math.hypot(u.x - h.x, u.y - h.y) <= eps)) unique.push(h);
  }
  return unique;
}

/**
 * True when a line's four control points are (near-)collinear, i.e. the Bézier
 * traces a straight segment — including the canonical [A,A,B,B] form. Returns
 * false for a zero-length line, which has no usable direction.
 */
function isStraightBezier(b: Bezier, tol = 1e-6): boolean {
  const dx = b[3].x - b[0].x;
  const dy = b[3].y - b[0].y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return false;
  // Perpendicular distance of each interior control point from the P0→P3 chord.
  for (const p of [b[1], b[2]]) {
    const cross = Math.abs((p.x - b[0].x) * dy - (p.y - b[0].y) * dx);
    if (cross / len > tol) return false;
  }
  return true;
}

/**
 * Intersect two infinite lines, each given by two distinct points on it.
 * Returns null when the lines are parallel (or coincident).
 */
function infiniteLineIntersection(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): Vec2 | null {
  const rx = a1.x - a0.x;
  const ry = a1.y - a0.y;
  const sx = b1.x - b0.x;
  const sy = b1.y - b0.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b0.x - a0.x) * sy - (b0.y - a0.y) * sx) / denom;
  return { x: a0.x + t * rx, y: a0.y + t * ry };
}

// ── Arc-length traversal of a cubic Bézier ───────────────────────────────────
// Used to locate a point a given distance along a "line" (which may be curved)
// and to read the curve's tangent there, so we can drop a perpendicular.

/** Evaluate a cubic Bézier B(t), t ∈ [0,1]. */
function bezierAt(b: Bezier, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const c1 = 3 * mt * mt * t;
  const c2 = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * b[0].x + c1 * b[1].x + c2 * b[2].x + d * b[3].x,
    y: a * b[0].y + c1 * b[1].y + c2 * b[2].y + d * b[3].y,
  };
}

/**
 * Find the point a given arc length from a Bézier's start point, plus the unit
 * tangent of the curve there. The curve is approximated as a fine polyline so
 * this works uniformly for straight segments ([A,A,B,B]) and curved ones.
 *
 * `total` (the curve's full length) is always returned. `point`/`tangent` are
 * present only when `dist` lies within [0, total] (a small tolerance is
 * allowed for floating-point overshoot at the endpoints).
 */
function pointAlongBezier(
  b: Bezier,
  dist: number,
  samples = 2000
): { total: number; point?: Vec2; tangent?: Vec2 } {
  const pts: Vec2[] = [bezierAt(b, 0)];
  const cum: number[] = [0];
  for (let i = 1; i <= samples; i++) {
    const cur = bezierAt(b, i / samples);
    const prev = pts[i - 1];
    cum.push(cum[i - 1] + Math.hypot(cur.x - prev.x, cur.y - prev.y));
    pts.push(cur);
  }
  const total = cum[cum.length - 1];
  if (total === 0) return { total };

  const tolerance = 1e-7 * total;
  if (dist < -tolerance || dist > total + tolerance) return { total };

  const target = Math.max(0, Math.min(dist, total));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const segStart = cum[i - 1];
  const segLen = cum[i] - segStart;
  const f = segLen > 0 ? (target - segStart) / segLen : 0;
  const a = pts[i - 1];
  const c = pts[i];
  const point = { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f };
  const tangent = { x: c.x - a.x, y: c.y - a.y };
  return { total, point, tangent };
}

// ── Point cross-reference helpers ─────────────────────────────────────────────

const POINT_REF_RE = /point\(([^)]+)->([xy])\)/g;

function pointDepsOf(formula: string): string[] {
  const names: string[] = [];
  const re = new RegExp(POINT_REF_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) names.push(m[1]);
  return names;
}

function inlinePointRefs(
  formula: string,
  resolved: Record<string, ResolvedPoint>
): string {
  return formula.replace(POINT_REF_RE, (match, name: string, coord: string) => {
    const pt = resolved[name];
    if (!pt) throw new Error(`Point "${name}" is not yet resolved (used in ${match})`);
    return String(pt[coord as "x" | "y"]);
  });
}

// ── Topological sort ──────────────────────────────────────────────────────────

function topoSort(
  names: string[],
  depsOf: (name: string) => string[]
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (inStack.has(name)) throw new Error(`Circular point reference at "${name}"`);
    inStack.add(name);
    for (const dep of depsOf(name)) {
      if (names.includes(dep)) visit(dep);
    }
    inStack.delete(name);
    visited.add(name);
    result.push(name);
  }

  for (const name of names) visit(name);
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function collectVariables(part: PartDef): string[] {
  const vars = new Set<string>();
  // Local variable names are NOT measurement inputs — exclude them from results
  // but DO scan their formulas so that any measurements they reference are included.
  const localNames = new Set(Object.keys(part.local_variables ?? {}));

  for (const expr of Object.values(part.local_variables ?? {})) {
    try {
      for (const v of detectParser.parse(expr).variables()) {
        if (!localNames.has(v)) vars.add(v);
      }
    } catch {}
  }

  for (const pd of Object.values(part.points)) {
    // Geometric-function points have no direct formula references; their
    // measurement variables come in through their line endpoint points.
    if (pd["x&y"]) continue;
    for (const expr of [pd.x, pd.y]) {
      if (typeof expr !== "string") continue;
      const stripped = expr.replace(POINT_REF_RE, "0");
      try {
        for (const v of detectParser.parse(stripped).variables()) {
          if (!localNames.has(v)) vars.add(v);
        }
      } catch {
        // Ignore parse errors; they surface during evaluation.
      }
    }
  }

  // Line visibility conditions can reference variables too.
  for (const line of Object.values(part.lines)) {
    if (typeof line.condition !== "string") continue;
    const stripped = line.condition.replace(CONDITION_IF_RE, "").replace(POINT_REF_RE, "0");
    try {
      for (const v of detectParser.parse(stripped).variables()) {
        if (!localNames.has(v)) vars.add(v);
      }
    } catch {
      // Ignore parse errors; they surface during evaluation.
    }
  }
  return [...vars].sort();
}

function evalFormula(parser: Parser, expr: string, scope: Measurements): number {
  const value = parser.parse(expr).evaluate(scope);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expression did not produce a finite number (got ${value})`);
  }
  return value;
}

// A line's optional `condition` may be written with a leading "if" keyword,
// e.g. "if hAbn > 4.5". Strip it before handing the expression to expr-eval.
const CONDITION_IF_RE = /^\s*if\b\s*/i;

/**
 * Evaluate a line's visibility condition to a boolean. Comparison expressions
 * yield a boolean directly; a numeric result is treated as truthy when non-zero
 * (0 → hidden). Sibling-point references are resolved first, like other formulas.
 */
function evalCondition(
  parser: Parser,
  raw: string,
  resolved: Record<string, ResolvedPoint>,
  scope: Measurements
): boolean {
  const expr = inlinePointRefs(raw.replace(CONDITION_IF_RE, ""), resolved).trim();
  if (expr === "") throw new Error("Empty condition");
  const value = parser.parse(expr).evaluate(scope);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Condition did not produce a finite value (got ${value})`);
    }
    return value !== 0;
  }
  throw new Error(`Condition must evaluate to a boolean or number (got ${typeof value})`);
}

export function evaluatePart(part: PartDef, measurements: Measurements): GeometryResult {
  const points: Record<string, ResolvedPoint> = {};
  const paths: Record<string, string> = {};
  const lineTypes: Record<string, string | undefined> = {};
  const errors: Record<string, string> = {};

  // Build a parser that won't shadow any user-defined name (measurements + locals)
  const localVarNames = Object.keys(part.local_variables ?? {});
  const parser = makeParser([...Object.keys(measurements), ...localVarNames]);

  // ── Evaluate local variables ───────────────────────────────────────────────
  // They can reference measurements and each other, so topo-sort them first.
  const localScope: Measurements = {};

  if (part.local_variables && localVarNames.length > 0) {
    // Detect inter-local dependencies with a parser that has the local names
    // stripped from its built-ins, so a local named like a built-in (e.g.
    // "length") is still seen as a referenced variable for topo-sorting.
    const localDetectParser = makeParser(localVarNames);
    const localDepsOf = (name: string): string[] => {
      const expr = part.local_variables![name];
      try {
        return localDetectParser.parse(expr).variables().filter((v) => localVarNames.includes(v));
      } catch {
        return [];
      }
    };

    let sortedLocalNames: string[];
    try {
      sortedLocalNames = topoSort(localVarNames, localDepsOf);
    } catch (err) {
      errors["__local_cycle__"] = (err as Error).message;
      sortedLocalNames = localVarNames;
    }

    // Evaluate each local variable; accumulate into localScope so later locals
    // can reference earlier ones.
    const runningScope = { ...measurements };
    for (const name of sortedLocalNames) {
      try {
        const val = evalFormula(parser, part.local_variables![name], runningScope);
        localScope[name] = val;
        runningScope[name] = val;
      } catch (err) {
        errors[`local.${name}`] = (err as Error).message;
      }
    }
  }

  // Full scope available to point formulas: measurements + resolved locals
  const fullScope: Measurements = { ...measurements, ...localScope };

  const pointNames = Object.keys(part.points);

  const depsOf = (name: string): string[] => {
    const pd = part.points[name];
    const xyExpr = pd["x&y"];
    if (xyExpr) {
      // Geo-function: depends on the endpoint points of the referenced lines.
      const gf = parseGeoFunc(xyExpr);
      if (gf?.func === "intersectLines") {
        return [...new Set(gf.args.flatMap((l) => linePointDeps(l, part)))];
      }
      if (gf?.func === "lotPointOnLineAtDistance") {
        // Depends on the endpoints of the referenced line plus any sibling
        // points referenced from its distance formulas.
        const lineDeps = gf.args[0] ? linePointDeps(gf.args[0], part) : [];
        const exprDeps = [...pointDepsOf(gf.args[1] ?? ""), ...pointDepsOf(gf.args[2] ?? "")];
        return [...new Set([...lineDeps, ...exprDeps])];
      }
      return [];
    }
    return [...pointDepsOf(pd.x ?? ""), ...pointDepsOf(pd.y ?? "")];
  };

  let sortedNames: string[];
  try {
    sortedNames = topoSort(pointNames, depsOf);
  } catch (err) {
    errors["__cycle__"] = (err as Error).message;
    sortedNames = pointNames;
  }

  for (const name of sortedNames) {
    const pd = part.points[name];
    const xyExpr = pd["x&y"];

    if (xyExpr) {
      // ── Geometric function ────────────────────────────────────────────────
      const gf = parseGeoFunc(xyExpr);
      if (!gf) {
        errors[name] = `Cannot parse geometric expression: ${xyExpr}`;
        continue;
      }
      if (gf.func === "intersectLines") {
        if (gf.args.length !== 2) {
          errors[name] = `intersectLines requires 2 line arguments, got ${gf.args.length}`;
          continue;
        }
        const [l1name, l2name] = gf.args;
        const l1 = part.lines[l1name];
        const l2 = part.lines[l2name];
        if (!l1) { errors[name] = `Unknown line "${l1name}"`; continue; }
        if (!l2) { errors[name] = `Unknown line "${l2name}"`; continue; }
        // Build each line as a full cubic Bézier from its four control points,
        // so curved segments intersect correctly (not just their P0→P3 chords).
        const toBezier = (refs: readonly string[]): Bezier | string => {
          const pts = refs.map((r) => points[r]);
          const missing = refs.filter((r) => !points[r]);
          if (missing.length) return [...new Set(missing)].join(", ");
          return pts.map((p) => ({ x: p.x, y: p.y })) as unknown as Bezier;
        };
        const bez1 = toBezier(l1.linePointReferences);
        if (typeof bez1 === "string") { errors[name] = `Unresolved point(s) for line "${l1name}": ${bez1}`; continue; }
        const bez2 = toBezier(l2.linePointReferences);
        if (typeof bez2 === "string") { errors[name] = `Unresolved point(s) for line "${l2name}": ${bez2}`; continue; }

        const crossings = intersectBeziers(bez1, bez2);
        if (crossings.length === 0) {
          // The bounded segments don't cross. When both lines are straight we
          // extend them to infinite lines and intersect those instead, so an
          // intersection that lies beyond the drawn segments is still found.
          if (isStraightBezier(bez1) && isStraightBezier(bez2)) {
            const hit = infiniteLineIntersection(bez1[0], bez1[3], bez2[0], bez2[3]);
            if (hit) {
              points[name] = { x: hit.x, y: hit.y, pointType: pd.pointType, position: pd.position };
            } else {
              errors[name] = `Lines "${l1name}" and "${l2name}" are parallel and do not intersect`;
            }
          } else {
            errors[name] = `Lines "${l1name}" and "${l2name}" do not intersect`;
          }
        } else {
          // A point definition yields a single location; take the first crossing.
          if (crossings.length > 1) {
            errors[`${name}.note`] =
              `Lines "${l1name}" and "${l2name}" cross ${crossings.length} times; using the first.`;
          }
          const { x, y } = crossings[0];
          points[name] = { x, y, pointType: pd.pointType, position: pd.position };
        }
      } else if (gf.func === "lotPointOnLineAtDistance") {
        // f:lotPointOnLineAtDistance(line, distanceAlongLine, distanceFromLine)
        // Drops a perpendicular ("Lot") onto `line` at the point that lies
        // `distanceAlongLine` (arc length, in cm) from the line's start point,
        // then returns the point `distanceFromLine` (cm) away along that
        // perpendicular. Positive offsets lie 90° counter-clockwise from the
        // line's start→end direction; negative offsets lie on the other side.
        if (gf.args.length !== 3) {
          errors[name] =
            `lotPointOnLineAtDistance requires 3 arguments (line, distanceAlongLine, distanceFromLine), got ${gf.args.length}`;
          continue;
        }
        const [lineName, alongExpr, offsetExpr] = gf.args;
        const line = part.lines[lineName];
        if (!line) { errors[name] = `Unknown line "${lineName}"`; continue; }

        const refs = line.linePointReferences;
        const missing = refs.filter((r) => !points[r]);
        if (missing.length) {
          errors[name] = `Unresolved point(s) for line "${lineName}": ${[...new Set(missing)].join(", ")}`;
          continue;
        }
        const bez = refs.map((r) => ({ x: points[r].x, y: points[r].y })) as unknown as Bezier;

        // The two distances are full formulas — resolve sibling-point refs then
        // evaluate against measurements + locals, exactly like x/y formulas.
        let along: number;
        let offset: number;
        try {
          along = evalFormula(parser, inlinePointRefs(alongExpr, points), fullScope);
        } catch (err) {
          errors[name] = `Cannot evaluate distance-along-line "${alongExpr}": ${(err as Error).message}`;
          continue;
        }
        try {
          offset = evalFormula(parser, inlinePointRefs(offsetExpr, points), fullScope);
        } catch (err) {
          errors[name] = `Cannot evaluate distance-from-line "${offsetExpr}": ${(err as Error).message}`;
          continue;
        }

        const foot = pointAlongBezier(bez, along);
        if (foot.total === 0) {
          errors[name] = `Line "${lineName}" has zero length; cannot create a perpendicular`;
          continue;
        }
        if (!foot.point || !foot.tangent) {
          errors[name] =
            `Distance ${along} along line "${lineName}" is outside the line (length ${foot.total.toFixed(4)})`;
          continue;
        }
        const tlen = Math.hypot(foot.tangent.x, foot.tangent.y);
        if (tlen === 0) {
          errors[name] = `Line "${lineName}" has no direction at distance ${along}; cannot orient the perpendicular`;
          continue;
        }
        // Unit tangent, then rotate 90° CCW to get the perpendicular direction.
        const ux = foot.tangent.x / tlen;
        const uy = foot.tangent.y / tlen;
        const x = foot.point.x - uy * offset;
        const y = foot.point.y + ux * offset;
        points[name] = { x, y, pointType: pd.pointType, position: pd.position };
      } else {
        errors[name] = `Unknown geometric function "f:${gf.func}"`;
      }
      continue;
    }

    // ── Formula-based point ─────────────────────────────────────────────────
    const { x: xExpr, y: yExpr, pointType, position } = pd;
    if (typeof xExpr !== "string" || typeof yExpr !== "string") {
      errors[name] = "Malformed point definition — expected { x, y } strings or an \"x&y\" geometric function";
      continue;
    }
    let x: number | undefined;
    let y: number | undefined;
    try {
      x = evalFormula(parser, inlinePointRefs(xExpr, points), fullScope);
    } catch (err) {
      errors[`${name}.x`] = (err as Error).message;
    }
    try {
      y = evalFormula(parser, inlinePointRefs(yExpr, points), fullScope);
    } catch (err) {
      errors[`${name}.y`] = (err as Error).message;
    }
    if (x !== undefined && y !== undefined) {
      points[name] = { x, y, pointType, position };
    }
  }

  for (const [name, line] of Object.entries(part.lines)) {
    // A line may be gated by a visibility condition. When it evaluates false the
    // line is omitted entirely (no path, no point-resolution errors) — it is
    // intentionally absent. A condition that fails to evaluate is reported and
    // the line is left out, since we can't confirm it should be shown.
    if (typeof line.condition === "string" && line.condition.trim() !== "") {
      let visible: boolean;
      try {
        visible = evalCondition(parser, line.condition, points, fullScope);
      } catch (err) {
        errors[`${name}.condition`] = (err as Error).message;
        continue;
      }
      if (!visible) continue;
    }

    lineTypes[name] = line.lineType;
    const refs = line.linePointReferences;
    const missing = refs.filter((r) => !(r in points));
    if (missing.length > 0) {
      errors[name] = `Unknown / unresolved point(s): ${[...new Set(missing)].join(", ")}`;
      continue;
    }
    const [p0, c1, c2, p3] = refs.map((r) => points[r]);
    paths[name] = `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p3.x} ${p3.y}`;
  }

  const coords = Object.values(points);
  const bbox =
    coords.length === 0
      ? null
      : {
          minX: Math.min(...coords.map((p) => p.x)),
          minY: Math.min(...coords.map((p) => p.y)),
          maxX: Math.max(...coords.map((p) => p.x)),
          maxY: Math.max(...coords.map((p) => p.y)),
        };

  return { points, paths, lineTypes, localValues: localScope, bbox, errors };
}
