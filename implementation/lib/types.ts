// Domain model for cutavis pattern geometry.

/**
 * A point's coordinates are expressed as formulas (strings) in terms of
 * measurement variables, e.g. x: "margin + width", y: "margin".
 * They are evaluated by the geometry engine against a Measurements set.
 *
 * pointType controls visibility:
 *   "aux"    — shown only when the "show points" checkbox is on
 *   "marker" — always visible
 *
 * position is a label-placement hint for the SVG renderer:
 *   "top-right" | "top-left" | "bottom-right" | "bottom-left"
 */
export interface PointDef {
  /** Formula for x — required unless "x&y" is used. */
  x?: string;
  /** Formula for y — required unless "x&y" is used. */
  y?: string;
  /** Geometric function that yields both coordinates, e.g. "f:intersectLines(L1,L2)".
   *  When present, x and y are ignored. */
  "x&y"?: string;
  pointType?: string;
  position?: string;
}

/**
 * A line segment is a cubic Bézier defined by four point references:
 * [start, control1, control2, end]. A straight line simply repeats the
 * endpoints, e.g. ["A", "A", "B", "B"].
 */
export interface LineDef {
  /** "seam" | "hem" | "aux" — controls visibility and stroke style. */
  lineType?: string;
  /** Optional visibility gate. A formula (optionally prefixed with "if "),
   *  e.g. "if hAbn > 4.5". The line is drawn only when this evaluates truthy;
   *  when it evaluates false the line is omitted entirely. May reference
   *  measurements, local variables, and point(NAME->x|y) cross-references. */
  condition?: string;
  linePointReferences: [string, string, string, string];
  mergeLineAliasInOtherPartalPattern?: string;
}

export interface PartDef {
  /** User-editable numeric constants specific to this part (e.g. ease/seam
   *  allowances). Exposed in the "Customize" UI and referenceable from
   *  local_variables and point formulas, just like measurement variables. */
  part_specific_user_definable_variables?: Record<string, number>;
  /** Optional constants / derived values, evaluated before points.
   *  Values are formula strings that may reference measurement variables,
   *  part_specific_user_definable_variables, or other local variables
   *  (earlier in dependency order). */
  local_variables?: Record<string, string>;
  points: Record<string, PointDef>;
  lines: Record<string, LineDef>;
}

export type Measurements = Record<string, number>;
