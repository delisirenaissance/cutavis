"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GeometryResult, ResolvedPoint } from "@/lib/geometry";
import { belongsToPart } from "@/lib/edits";
import { DefineLayer, type DefineOverlay } from "./DefineLayer";
import {
  snapToBoundary,
  bezierToPath,
  bezierAt,
  parsePathBezier,
  buildArcTable,
  arcAt,
  pointAtArc,
  arcDistance,
  arcPolyline,
  type BoundarySeg,
  type Bezier,
  type Snap,
  type Vec2,
} from "@/lib/split";

/** Parse a typed distance ("12", "12.5", "12,5"); null if not a number ≥ 0. */
function parseDistance(s: string): number | null {
  if (!/^\d*[.,]?\d*$/.test(s) || !/\d/.test(s)) return null;
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Live cut-drawing state handed down while a split is in progress. */
export interface CutOverlay {
  /** The outline of the piece being cut, to snap clicks onto. */
  loop: BoundarySeg[];
  phase: "start" | "end" | "adjust";
  from: Vec2 | null;
  to: Vec2 | null;
  /** The preview cut curve (start→end, with any bow), for the dashed line. */
  preview: Bezier | null;
  /** Positions of the cut Bézier's two control points (once both ends exist). */
  controls: [Vec2, Vec2] | null;
  /** Sub-mode: draw the cut line, or measure distances along the outline. */
  mode: "draw" | "measure";
  /** Temporary marks created by measuring (snap targets for the cut line). */
  marks: Vec2[];
  /** Measure mode: keep a measured end point as a temporary mark. */
  onAddMark: (snap: { line: string; t: number; point: Vec2 }) => void;
  /** Place the next cut point (snapped onto the outline). */
  onPlace: (snap: { line: string; t: number; point: Vec2 }) => void;
  /** Drag a placed start/end point; reports the new outline-snapped position. */
  onMoveEnd: (which: "from" | "to", snap: { line: string; t: number; point: Vec2 }) => void;
  /** Drag a control point; reports its geometry-space position. */
  onMoveControl: (which: "c1" | "c2", p: Vec2) => void;
}

/** Live rotate-drawing state handed down while a rotation is in progress. */
export interface RotateOverlay {
  /** The outline of the piece being rotated, to snap the center onto. */
  loop: BoundarySeg[];
  /** The piece being rotated (its group gets the live rotate transform). */
  partId: string;
  /** The chosen rotation center (geometry space), or null while picking it. */
  center: Vec2 | null;
  /** Pick the rotation center (snapped onto a seam). */
  onPickCenter: (snap: { line: string; t: number; point: Vec2 }) => void;
  /** Commit the rotation once the drag ends, with the net angle in radians. */
  onCommit: (angle: number) => void;
}

/** Live merge-drawing state: individual outline segments the user hovers/picks. */
export interface MergeOverlay {
  segments: {
    key: string;
    bezier: Bezier;
    role: "plain" | "selected" | "candidate" | "chosen" | "dim";
    clickable: boolean;
  }[];
  onPick: (key: string) => void;
}

/** One part to draw, with its already-edit-applied geometry. */
export interface PartGeom {
  id: string;
  geometry: GeometryResult;
  /** Display name, drawn at the piece's centre (falls back to the id). */
  name?: string;
}

interface Props {
  parts: PartGeom[];
  showAuxLines: boolean;
  showPoints: boolean;
  /** id of the part currently selected on the plot (highlighted, movable). */
  selectedPart: string | null;
  /** id of the part to highlight in blue (from clicking its name in the list). */
  highlightedPart?: string | null;
  /** When true the plot is editable: parts can be selected/dragged and the
   *  background turns yellow. Edit interactions are disabled otherwise. */
  editMode?: boolean;
  /** In edit-mode, the part chosen in the dropdown. Every other part is dimmed. */
  activePart?: string | null;
  /** Called with a part id to select, or null to clear the selection. */
  onSelectPart: (id: string | null) => void;
  /** Called once when a drag ends, with the net offset in geometry units. */
  onMovePart: (id: string, dx: number, dy: number) => void;
  /** When set, a cut is being drawn; the plot switches to cut-picking mode. */
  cut?: CutOverlay | null;
  /** When set, a rotation is being drawn; the plot switches to rotate mode. */
  rotate?: RotateOverlay | null;
  /** When set, a merge is being set up; outline segments become hover/pick-able. */
  merge?: MergeOverlay | null;
  /** Seam-allowance polygon per piece id (omitted pieces get none). */
  allowances?: Record<string, Vec2[]>;
  /** When set, the "Define part" mode is active (measuring / part preview). */
  define?: DefineOverlay | null;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Compute label offset and text-anchor from the point's position hint. */
function labelProps(
  p: ResolvedPoint,
  unit: number
): { dx: number; dy: number; anchor: "start" | "end" | "middle" } {
  switch (p.position) {
    case "top-left":     return { dx: -unit * 3, dy: -unit * 3, anchor: "end"   };
    case "bottom-right": return { dx:  unit * 3, dy:  unit * 8, anchor: "start" };
    case "bottom-left":  return { dx: -unit * 3, dy:  unit * 8, anchor: "end"   };
    default:             return { dx:  unit * 1.2, dy: -unit * 1.2, anchor: "start" }; // top-right
  }
}

interface DragState {
  id: string;
  startClientX: number;
  startClientY: number;
  dx: number; // current offset in geometry units
  dy: number;
  moved: boolean;
}

export function PatternSvg({
  parts,
  showAuxLines,
  showPoints,
  selectedPart,
  highlightedPart,
  editMode = false,
  activePart,
  onSelectPart,
  onMovePart,
  cut = null,
  rotate = null,
  merge = null,
  allowances = {},
  define = null,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [mergeHover, setMergeHover] = useState<string | null>(null);
  // Snapped point under the cursor while placing cut points.
  const [cutHover, setCutHover] = useState<Vec2 | null>(null);
  // Measure mode: the measurement's start (arc position + point), the snapped
  // cursor position on the outline (+ raw cursor for the label), and the
  // distance being typed by the user (empty = show the live measured value).
  const [measureStart, setMeasureStart] = useState<{ s: number; point: Vec2 } | null>(null);
  const [measureHover, setMeasureHover] = useState<{ s: number; point: Vec2; cursor: Vec2 } | null>(null);
  const [typed, setTyped] = useState("");
  // Rotate mode: snapped center preview, cursor position for the handle line,
  // and the live drag angle (radians) applied as a preview transform.
  const [rotHover, setRotHover] = useState<Vec2 | null>(null);
  const [rotDrag, setRotDrag] = useState<{ start: number; angle: number } | null>(null);

  // Overall bounds across every part (committed positions).
  let bbox: Box | null = null;
  for (const part of parts) bbox = unionBox(bbox, part.geometry.bbox);

  const pad = bbox
    ? Math.max((bbox.maxX - bbox.minX) * 0.1, (bbox.maxY - bbox.minY) * 0.1, 5)
    : 5;
  const x = bbox ? bbox.minX - pad : 0;
  const y = bbox ? bbox.minY - pad : 0;
  const w = bbox ? bbox.maxX - bbox.minX + pad * 2 : 1;
  const h = bbox ? bbox.maxY - bbox.minY + pad * 2 : 1;
  const unit = Math.max(w, h) / 200;

  // ── Measure-mode derived state ──────────────────────────────────────────────
  const cutLoop = cut?.loop ?? null;
  const arcTab = useMemo(() => (cutLoop && cutLoop.length ? buildArcTable(cutLoop) : null), [cutLoop]);
  const measuring = cut?.mode === "measure";

  // Leaving measure mode (or the cut) discards an unfinished measurement.
  useEffect(() => {
    setMeasureStart(null);
    setMeasureHover(null);
    setTyped("");
    setCutHover(null);
  }, [cut?.mode, cut == null]);

  // The current measurement: from the start point to the cursor along the
  // shorter way round the outline — or, while a value is being typed, to the
  // point that lies that typed distance away in the same direction.
  const measure = useMemo(() => {
    if (!arcTab || !measureStart || !measureHover) return null;
    const live = arcDistance(arcTab, measureStart.s, measureHover.s);
    const typedVal = typed ? parseDistance(typed) : null;
    const tooLong = typedVal != null && typedVal > arcTab.total;
    const dist = typedVal != null && !tooLong ? typedVal : live.dist;
    const end = pointAtArc(arcTab, measureStart.s + live.dir * dist);
    return {
      dist,
      dir: live.dir,
      end,
      typedInvalid: typed !== "" && (typedVal == null || tooLong),
      path: arcPolyline(arcTab, measureStart.s, dist, live.dir),
    };
  }, [arcTab, measureStart, measureHover, typed]);

  // Drag: translate client-pixel deltas into geometry units via the rendered
  // scale, then commit a single move edit on release.
  useEffect(() => {
    if (!drag) return;

    function geomUnitsPerPixel(): number {
      const el = svgRef.current;
      if (!el) return 1;
      const r = el.getBoundingClientRect();
      // preserveAspectRatio="meet": the viewBox is scaled uniformly to fit.
      const pxPerUnit = Math.min(r.width / w, r.height / h);
      return pxPerUnit > 0 ? 1 / pxPerUnit : 1;
    }

    function onMove(e: MouseEvent) {
      const upp = geomUnitsPerPixel();
      const dxPx = e.clientX - drag!.startClientX;
      const dyPx = e.clientY - drag!.startClientY;
      setDrag((d) =>
        d
          ? {
              ...d,
              dx: dxPx * upp,
              dy: dyPx * upp,
              moved: d.moved || Math.abs(dxPx) + Math.abs(dyPx) > 3,
            }
          : d
      );
    }

    function onUp() {
      setDrag((d) => {
        if (d && d.moved && (d.dx !== 0 || d.dy !== 0)) {
          onMovePart(d.id, d.dx, d.dy);
        }
        return null;
      });
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // Re-bind only when a new drag starts (id changes); handlers read live
    // values via the functional setState updater.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id]);

  function startDrag(e: React.MouseEvent, id: string) {
    // Selecting and moving parts is only allowed in edit-mode, and never while
    // a cut/rotation/merge is being drawn (their layers handle the pointer then).
    if (!editMode || cut || rotate || merge || define) return;
    e.preventDefault();
    e.stopPropagation();
    onSelectPart(id);
    setDrag({ id, startClientX: e.clientX, startClientY: e.clientY, dx: 0, dy: 0, moved: false });
  }

  // Convert a client-pixel position to geometry coordinates, accounting for the
  // uniform "meet" scaling and letterboxing of the viewBox.
  function clientToGeom(clientX: number, clientY: number): Vec2 {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const scale = Math.min(r.width / w, r.height / h) || 1;
    const offX = (r.width - w * scale) / 2;
    const offY = (r.height - h * scale) / 2;
    return {
      x: x + (clientX - r.left - offX) / scale,
      y: y + (clientY - r.top - offY) / scale,
    };
  }

  // ── Cut-drawing pointer handlers ────────────────────────────────────────────

  // Snap a pointer position onto the outline, preferring (within a small
  // radius) the temporary marks and the outline's corners, so points can be
  // placed exactly on them.
  function snapCut(g: Vec2): Snap | null {
    if (!cut) return null;
    const targets: Vec2[] = [...cut.marks, ...cut.loop.map((s) => s.bezier[0])];
    let best: Vec2 | null = null;
    let bestD = unit * 2.5;
    for (const q of targets) {
      const d = Math.hypot(q.x - g.x, q.y - g.y);
      if (d <= bestD) { bestD = d; best = q; }
    }
    if (!best) return snapToBoundary(cut.loop, g);
    const s = snapToBoundary(cut.loop, best);
    return s ? { ...s, point: { ...best }, dist: bestD } : null;
  }

  // Mark the end of the current measurement and start afresh.
  function commitMeasure(at: { line: string; t: number; point: Vec2 }) {
    cut?.onAddMark(at);
    setMeasureStart(null);
    setTyped("");
  }

  function onCutMove(e: React.MouseEvent) {
    if (!cut) return;
    const g = clientToGeom(e.clientX, e.clientY);
    if (measuring) {
      const snap = snapCut(g);
      if (!snap || !arcTab) return;
      setCutHover(snap.point);
      setMeasureHover({ s: arcAt(arcTab, snap.segIndex, snap.t), point: snap.point, cursor: g });
      return;
    }
    if (cut.phase === "adjust") return;
    const snap = snapCut(g);
    if (snap) setCutHover(snap.point);
  }

  function onCutDown(e: React.MouseEvent) {
    if (!cut) return;
    if (!measuring && cut.phase === "adjust") return;
    e.preventDefault();
    e.stopPropagation();
    const g = clientToGeom(e.clientX, e.clientY);
    const snap = snapCut(g);
    if (!snap) return;
    if (measuring) {
      if (!arcTab) return;
      if (!measureStart) {
        setMeasureStart({ s: arcAt(arcTab, snap.segIndex, snap.t), point: snap.point });
        setTyped("");
      } else {
        // A click marks the clicked point (a typed value is only used on Enter).
        commitMeasure({ line: snap.line, t: snap.t, point: snap.point });
      }
      return;
    }
    cut.onPlace({ line: snap.line, t: snap.t, point: snap.point });
  }

  // Keyboard entry while a measurement is running: digits / "." / "," edit the
  // distance, Backspace deletes, Enter marks the point (at the typed distance,
  // or at the cursor if nothing was typed), Esc clears the typed value or
  // cancels the measurement. Uses a ref so the listener sees current state.
  const measureKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  measureKeyRef.current = (e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return;
    if (/^[0-9.,]$/.test(e.key)) {
      setTyped((t) => t + e.key);
    } else if (e.key === "Backspace") {
      setTyped((t) => t.slice(0, -1));
    } else if (e.key === "Enter") {
      if (!measure) return;
      if (typed !== "" && measure.typedInvalid) return;
      const p = measure.end;
      commitMeasure({ line: p.line, t: p.t, point: p.point });
    } else if (e.key === "Escape") {
      if (typed) setTyped("");
      else setMeasureStart(null);
    } else {
      return;
    }
    e.preventDefault();
  };
  const measureActive = measuring && measureStart != null;
  useEffect(() => {
    if (!measureActive) return;
    const onKey = (e: KeyboardEvent) => measureKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [measureActive]);

  // Drag one of the cut's handles until mouse-up. Start/end points re-snap onto
  // the outline on every move; control points follow the pointer freely.
  function onCutHandleDown(e: React.MouseEvent, handle: "from" | "to" | "c1" | "c2") {
    if (!cut) return;
    e.preventDefault();
    e.stopPropagation();
    const c = cut; // the callbacks are stable for the duration of the cut
    const move = (ev: MouseEvent) => {
      const g = clientToGeom(ev.clientX, ev.clientY);
      if (handle === "from" || handle === "to") {
        const snap = snapCut(g);
        if (snap) c.onMoveEnd(handle, { line: snap.line, t: snap.t, point: snap.point });
      } else {
        c.onMoveControl(handle, g);
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ── Rotate-drawing pointer handlers ─────────────────────────────────────────
  function onRotMove(e: React.MouseEvent) {
    if (!rotate || rotDrag) return; // during the drag the window listener runs
    const g = clientToGeom(e.clientX, e.clientY);
    if (!rotate.center) {
      const snap = snapToBoundary(rotate.loop, g);
      setRotHover(snap ? snap.point : null);
    } else {
      setRotHover(g); // armed: dashed line from center to cursor
    }
  }

  function onRotDown(e: React.MouseEvent) {
    if (!rotate) return;
    const g = clientToGeom(e.clientX, e.clientY);
    if (!rotate.center) {
      // Pick the rotation center on a seam.
      const snap = snapToBoundary(rotate.loop, g);
      if (snap) rotate.onPickCenter({ line: snap.line, t: snap.t, point: snap.point });
      return;
    }
    // Armed → click-and-hold to rotate around the center.
    e.preventDefault();
    e.stopPropagation();
    const c = rotate.center;
    const start = Math.atan2(g.y - c.y, g.x - c.x);
    setRotDrag({ start, angle: 0 });
    const move = (ev: MouseEvent) => {
      const p = clientToGeom(ev.clientX, ev.clientY);
      setRotHover(p);
      setRotDrag({ start, angle: Math.atan2(p.y - c.y, p.x - c.x) - start });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const p = clientToGeom(ev.clientX, ev.clientY);
      const angle = Math.atan2(p.y - c.y, p.x - c.x) - start;
      setRotDrag(null);
      if (Math.abs(angle) > 1e-4) rotate.onCommit(angle);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  if (!bbox) {
    return (
      <div className="subtitle">No points to display — fix the formulas on the left.</div>
    );
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`${x} ${y} ${w} ${h}`}
      width={w * 8}
      height={h * 8}
      role="img"
    >
      {/* Background: bright yellow signals edit-mode; clicking empty space
          clears the current selection (edit-mode only). */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={editMode ? "#ffffcc" : "transparent"}
        onMouseDown={editMode && !cut && !rotate && !merge && !define ? () => onSelectPart(null) : undefined}
      />

      {parts.map((part) => {
        const g = part.geometry;
        // Selection targets a specific piece (exact id); highlight and dimming
        // target a part and every part derived from it by cuts (partA → partA_1,
        // partA_2_1, …), so highlighting "partA_2" lights up all its sub-parts.
        const isSelected = part.id === selectedPart;
        const isHighlighted = highlightedPart != null && belongsToPart(part.id, highlightedPart);
        // In edit-mode, every piece not belonging to the part picked in the
        // dropdown is dimmed (thinner, medium grey) so the active part stands out.
        const isDimmed = editMode && activePart != null && !belongsToPart(part.id, activePart);
        const isDragging = drag?.id === part.id;
        const tx = isDragging ? drag!.dx : 0;
        const ty = isDragging ? drag!.dy : 0;
        // Live rotation preview: while dragging a rotation, transform the piece's
        // group about the chosen center.
        const isRotating = !!rotate && !!rotDrag && !!rotate.center && part.id === rotate.partId;
        const transform = isRotating
          ? `rotate(${(rotDrag!.angle * 180) / Math.PI} ${rotate!.center!.x} ${rotate!.center!.y})`
          : tx || ty
          ? `translate(${tx} ${ty})`
          : undefined;

        const visiblePoints = Object.entries(g.points).filter(
          ([, p]) => p.pointType === "marker" || showPoints
        );

        return (
          <g
            key={part.id}
            transform={transform}
            onMouseDown={(e) => startDrag(e, part.id)}
            style={{
              cursor: editMode && !rotate ? (isDragging ? "grabbing" : "grab") : "default",
            }}
          >
            {/* Seam allowance (cutting line) around the piece. */}
            {allowances[part.id] && (
              <polygon
                points={allowances[part.id].map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={isDimmed ? "#dddddd" : "#aaaaaa"}
                strokeWidth={unit * 0.6}
                strokeLinejoin="round"
                pointerEvents="none"
              />
            )}
            {Object.entries(g.paths).map(([name, d]) => {
              const lt = g.lineTypes[name];
              if (lt === "aux" && !showAuxLines) return null;
              const isAux = lt === "aux";
              return (
                <g key={name}>
                  {/* Wide transparent hit area so the thin line is easy to grab. */}
                  <path d={d} fill="none" stroke="transparent" strokeWidth={unit * 4} />
                  <path
                    d={d}
                    fill="none"
                    stroke={
                      isAux
                        ? isDimmed
                          ? "#bbb"
                          : isHighlighted
                          ? "#8ab4f8"
                          : "#999"
                        : isDimmed
                        ? "#888"
                        : isHighlighted
                        ? "#1a73e8"
                        : isSelected
                        ? "#d8431b"
                        : "#111"
                    }
                    strokeWidth={
                      isAux
                        ? unit * 0.6
                        : isDimmed
                        ? unit * 0.6
                        : isHighlighted
                        ? unit * 1.6
                        : unit * 1.0
                    }
                    strokeDasharray={isAux ? `${unit * 3} ${unit * 2}` : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                </g>
              );
            })}

            {/* Selection outline around the part's bounds. */}
            {isSelected && g.bbox && (
              <rect
                x={g.bbox.minX - unit * 2}
                y={g.bbox.minY - unit * 2}
                width={g.bbox.maxX - g.bbox.minX + unit * 4}
                height={g.bbox.maxY - g.bbox.minY + unit * 4}
                fill="none"
                stroke="#6ea8fe"
                strokeWidth={unit * 0.6}
                strokeDasharray={`${unit * 2} ${unit * 2}`}
                pointerEvents="none"
              />
            )}

            {/* Piece label at the centre of its bounds: the display name in
                bold, or the id in a muted grey when the piece has no name. */}
            {g.bbox && (
              <text
                x={(g.bbox.minX + g.bbox.maxX) / 2}
                y={(g.bbox.minY + g.bbox.maxY) / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={unit * (part.name ? 4.6 : 3.4)}
                fontWeight={part.name ? 700 : 400}
                fill={isDimmed ? "#aaa" : part.name ? "#222" : "#8a8f98"}
                pointerEvents="none"
              >
                {part.name || part.id}
              </text>
            )}

            {/* Merge markers (screen only, never printed): label at the line's
                midpoint, e.g. "waistline-front". */}
            {Object.entries(g.lineSpecs ?? {}).map(([name, spec]) => {
              if (!spec.marker) return null;
              const b = parsePathBezier(g.paths[name]);
              if (!b) return null;
              const m = bezierAt(b, 0.5);
              return (
                <text
                  key={`mk-${name}`}
                  x={m.x + unit * 1.2} y={m.y - unit * 1.2}
                  fontSize={unit * 3.2} fill="#8e44ad" fontStyle="italic"
                  pointerEvents="none"
                >
                  {spec.marker}
                </text>
              );
            })}

            {visiblePoints.map(([name, p]) => {
              const { dx, dy, anchor } = labelProps(p, unit);
              return (
                <g key={name} pointerEvents="none">
                  <circle cx={p.x} cy={p.y} r={unit * 1} fill="#d8431b" />
                  <text
                    x={p.x + dx}
                    y={p.y + dy}
                    fontSize={unit * 4}
                    fill="#333"
                    fontFamily="monospace"
                    textAnchor={anchor}
                  >
                    {name}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}

      {/* ── Cut-drawing overlay ─────────────────────────────────────────────
          A transparent layer on top captures the pointer while cutting, so the
          parts underneath don't get selected/dragged. Markers/handles render
          above it so they stay interactive. */}
      {cut && (
        <g>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill="transparent"
            style={{ cursor: measuring || cut.phase !== "adjust" ? "crosshair" : "default" }}
            onMouseMove={onCutMove}
            onMouseDown={onCutDown}
          />

          {/* Snapped focus point while placing / measuring. */}
          {(measuring || cut.phase !== "adjust") && cutHover && (
            <g pointerEvents="none">
              <circle cx={cutHover.x} cy={cutHover.y} r={unit * 1.8} fill="none" stroke="#1a73e8" strokeWidth={unit * 0.5} />
              <circle cx={cutHover.x} cy={cutHover.y} r={unit * 0.6} fill="#1a73e8" />
            </g>
          )}

          {/* Rubber-band from the placed start point to the cursor. */}
          {!measuring && cut.phase === "end" && cut.from && cutHover && (
            <line
              x1={cut.from.x} y1={cut.from.y} x2={cutHover.x} y2={cutHover.y}
              stroke="#1a73e8" strokeWidth={unit * 0.8}
              strokeDasharray={`${unit * 2} ${unit * 1.5}`} pointerEvents="none"
            />
          )}

          {/* The cut curve (with any bow) once both points are placed. */}
          {cut.phase === "adjust" && cut.preview && (
            <path
              d={bezierToPath(cut.preview)} fill="none" stroke="#1a73e8"
              strokeWidth={unit * 1.0} strokeDasharray={`${unit * 2} ${unit * 1.5}`}
              pointerEvents="none"
            />
          )}

          {/* Bézier tangent lines: start → control 1, control 2 → end. */}
          {!measuring && cut.phase === "adjust" && cut.from && cut.to && cut.controls && (
            <g pointerEvents="none" stroke="#1a73e8" strokeWidth={unit * 0.4} opacity={0.7}>
              <line x1={cut.from.x} y1={cut.from.y} x2={cut.controls[0].x} y2={cut.controls[0].y} />
              <line x1={cut.to.x} y1={cut.to.y} x2={cut.controls[1].x} y2={cut.controls[1].y} />
            </g>
          )}

          {/* Start/end markers. Once both are placed they become draggable
              (they slide along the outline). */}
          {(["from", "to"] as const).map((k) => {
            const p = cut[k];
            if (!p) return null;
            const draggable = !measuring && cut.phase === "adjust";
            return (
              <circle
                key={k}
                cx={p.x} cy={p.y} r={unit * (draggable ? 1.8 : 1.3)}
                fill="#1a73e8"
                stroke={draggable ? "#fff" : "none"} strokeWidth={unit * 0.5}
                style={{ cursor: draggable ? "move" : "default" }}
                pointerEvents={draggable ? "all" : "none"}
                onMouseDown={draggable ? (e) => onCutHandleDown(e, k) : undefined}
              >
                {draggable && <title>{k === "from" ? "Start point — drag along the outline" : "End point — drag along the outline"}</title>}
              </circle>
            );
          })}

          {/* The two Bézier control points (hollow squares), freely draggable. */}
          {!measuring && cut.phase === "adjust" && cut.controls && cut.controls.map((p, i) => {
            const s = unit * 3.2;
            return (
              <rect
                key={i}
                x={p.x - s / 2} y={p.y - s / 2} width={s} height={s}
                fill="#fff" stroke="#1a73e8" strokeWidth={unit * 0.6}
                style={{ cursor: "grab" }}
                onMouseDown={(e) => onCutHandleDown(e, i === 0 ? "c1" : "c2")}
              >
                <title>{`Control point ${i + 1} — drag to curve the cut`}</title>
              </rect>
            );
          })}

          {/* Temporary marks from measuring (orange diamonds, numbered). In
              cut-line mode they are snap targets for the start/end points. */}
          {cut.marks.map((p, i) => {
            const r = unit * 1.6;
            return (
              <g key={i} pointerEvents="none">
                <path
                  d={`M ${p.x} ${p.y - r} L ${p.x + r} ${p.y} L ${p.x} ${p.y + r} L ${p.x - r} ${p.y} Z`}
                  fill="#f08c00" stroke="#fff" strokeWidth={unit * 0.35}
                />
                <text x={p.x + r * 1.2} y={p.y - r * 1.2} fontSize={unit * 3.2} fill="#c25e00" fontWeight={600}>
                  {`M${i + 1}`}
                </text>
              </g>
            );
          })}

          {/* Running measurement: start point, measured stretch along the
              outline, end-point preview and the distance at the cursor. */}
          {measuring && measureStart && (
            <circle cx={measureStart.point.x} cy={measureStart.point.y} r={unit * 1.4}
              fill="#2b8a3e" stroke="#fff" strokeWidth={unit * 0.4} pointerEvents="none" />
          )}
          {measuring && measure && measureHover && (() => {
            const label = typed !== "" ? `${typed}▏ cm` : `${measure.dist.toFixed(1)} cm`;
            const fs = unit * 3.6;
            const padX = fs * 0.4;
            const tw = label.length * fs * 0.6 + padX * 2;
            const tx = measureHover.cursor.x + unit * 2.5;
            const ty = measureHover.cursor.y - unit * 2.5;
            const color = measure.typedInvalid ? "#d6336c" : "#2b8a3e";
            return (
              <g pointerEvents="none">
                <polyline
                  points={measure.path.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none" stroke="#2b8a3e" strokeOpacity={0.55}
                  strokeWidth={unit * 1.6} strokeLinecap="round" strokeLinejoin="round"
                />
                <circle cx={measure.end.point.x} cy={measure.end.point.y} r={unit * 1.6}
                  fill="none" stroke="#f08c00" strokeWidth={unit * 0.6} />
                <rect x={tx} y={ty - fs * 1.1} width={tw} height={fs * 1.5} rx={fs * 0.3}
                  fill="#fff" stroke={color} strokeWidth={unit * 0.35} opacity={0.95} />
                <text x={tx + padX} y={ty} fontSize={fs} fill={color}
                  fontFamily="ui-monospace, Menlo, monospace" fontWeight={600}>
                  {label}
                </text>
              </g>
            );
          })()}
        </g>
      )}

      {/* ── Define-line overlay (measuring on any outline + part preview) ── */}
      {define && <DefineLayer overlay={define} box={{ x, y, w, h }} unit={unit} toGeom={clientToGeom} />}

      {/* ── Rotate overlay ──────────────────────────────────────────────────
          Same capture-layer approach: pick a center on a seam, then click-hold
          -drag to rotate the piece about it. */}
      {rotate && (
        <g>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill="transparent"
            style={{ cursor: !rotate.center ? "crosshair" : rotDrag ? "grabbing" : "grab" }}
            onMouseMove={onRotMove}
            onMouseDown={onRotDown}
          />

          {/* Snapped center preview while picking. */}
          {!rotate.center && rotHover && (
            <g pointerEvents="none">
              <circle cx={rotHover.x} cy={rotHover.y} r={unit * 1.8} fill="none" stroke="#8a2be2" strokeWidth={unit * 0.5} />
              <circle cx={rotHover.x} cy={rotHover.y} r={unit * 0.6} fill="#8a2be2" />
            </g>
          )}

          {/* Dashed radius from the center to the cursor (armed and dragging). */}
          {rotate.center && rotHover && (
            <line
              x1={rotate.center.x} y1={rotate.center.y} x2={rotHover.x} y2={rotHover.y}
              stroke="#8a2be2" strokeWidth={unit * 0.8}
              strokeDasharray={`${unit * 2} ${unit * 1.5}`} pointerEvents="none"
            />
          )}

          {/* The rotation center pivot. */}
          {rotate.center && (
            <g pointerEvents="none">
              <circle cx={rotate.center.x} cy={rotate.center.y} r={unit * 2} fill="none" stroke="#8a2be2" strokeWidth={unit * 0.6} />
              <circle cx={rotate.center.x} cy={rotate.center.y} r={unit * 0.8} fill="#8a2be2" />
            </g>
          )}
        </g>
      )}

      {/* ── Merge overlay ───────────────────────────────────────────────────
          Highlight outline segments by role; clickable ones get a wide hit path
          that brightens on hover and picks on click. */}
      {merge && (
        <g>
          {merge.segments.map((s) => {
            const hovered = mergeHover === s.key && s.clickable;
            const color =
              s.role === "selected" ? "#1a73e8"
              : s.role === "chosen" ? "#e8731a"
              : s.role === "candidate" ? "#1aa34a"
              : s.role === "dim" ? "#cccccc"
              : "#111";
            const width =
              hovered || s.role === "selected" || s.role === "chosen" ? unit * 2
              : s.role === "candidate" ? unit * 1.4
              : s.role === "dim" ? unit * 0.5
              : unit * 1.0;
            return (
              <g key={s.key}>
                <path
                  d={bezierToPath(s.bezier)} fill="none"
                  stroke={hovered ? "#1a73e8" : color} strokeWidth={width}
                  strokeLinecap="round" pointerEvents="none"
                />
                {s.clickable && (
                  <path
                    d={bezierToPath(s.bezier)} fill="none" stroke="transparent" strokeWidth={unit * 4}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setMergeHover(s.key)}
                    onMouseLeave={() => setMergeHover((h) => (h === s.key ? null : h))}
                    onMouseDown={(e) => { e.stopPropagation(); merge.onPick(s.key); }}
                  />
                )}
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}
