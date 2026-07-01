"use client";

import { useEffect, useRef, useState } from "react";
import type { GeometryResult, ResolvedPoint } from "@/lib/geometry";
import { rootPartOf } from "@/lib/edits";
import {
  snapToBoundary,
  bezierAt,
  bezierToPath,
  type BoundarySeg,
  type Bezier,
  type Vec2,
} from "@/lib/split";

/** Live cut-drawing state handed down while a split is in progress. */
export interface CutOverlay {
  /** The outline of the piece being cut, to snap clicks onto. */
  loop: BoundarySeg[];
  phase: "start" | "end" | "adjust";
  from: Vec2 | null;
  to: Vec2 | null;
  /** The preview cut curve (start→end, with any bow), for the dashed line. */
  preview: Bezier | null;
  /** Place the next cut point (snapped onto the outline). */
  onPlace: (snap: { line: string; t: number; point: Vec2 }) => void;
  /** Drag the cut into a curve — reports the handle's geometry-space position. */
  onBow: (handle: Vec2) => void;
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
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [mergeHover, setMergeHover] = useState<string | null>(null);
  // Snapped point under the cursor while placing cut points.
  const [cutHover, setCutHover] = useState<Vec2 | null>(null);
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
    if (!editMode || cut || rotate || merge) return;
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
  function onCutMove(e: React.MouseEvent) {
    if (!cut || cut.phase === "adjust") return;
    const g = clientToGeom(e.clientX, e.clientY);
    const snap = snapToBoundary(cut.loop, g);
    if (snap) setCutHover(snap.point);
  }

  function onCutDown(e: React.MouseEvent) {
    if (!cut || cut.phase === "adjust") return;
    e.preventDefault();
    e.stopPropagation();
    const g = clientToGeom(e.clientX, e.clientY);
    const snap = snapToBoundary(cut.loop, g);
    if (snap) cut.onPlace({ line: snap.line, t: snap.t, point: snap.point });
  }

  function onBowDown(e: React.MouseEvent) {
    if (!cut) return;
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: MouseEvent) => cut.onBow(clientToGeom(ev.clientX, ev.clientY));
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
        fill={editMode ? "#ffff00" : "transparent"}
        onMouseDown={editMode && !cut && !rotate && !merge ? () => onSelectPart(null) : undefined}
      />

      {parts.map((part) => {
        const g = part.geometry;
        // Selection targets a specific piece (exact id); highlight and dimming
        // target a whole loaded part, so they match every piece of it by root.
        const isSelected = part.id === selectedPart;
        const isHighlighted = highlightedPart != null && rootPartOf(part.id) === highlightedPart;
        // In edit-mode, every piece not belonging to the part picked in the
        // dropdown is dimmed (thinner, medium grey) so the active part stands out.
        const isDimmed = editMode && activePart != null && rootPartOf(part.id) !== activePart;
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
            style={{ cursor: cut.phase === "adjust" ? "default" : "crosshair" }}
            onMouseMove={onCutMove}
            onMouseDown={onCutDown}
          />

          {/* Snapped focus point while placing. */}
          {cut.phase !== "adjust" && cutHover && (
            <g pointerEvents="none">
              <circle cx={cutHover.x} cy={cutHover.y} r={unit * 1.8} fill="none" stroke="#1a73e8" strokeWidth={unit * 0.5} />
              <circle cx={cutHover.x} cy={cutHover.y} r={unit * 0.6} fill="#1a73e8" />
            </g>
          )}

          {/* Rubber-band from the placed start point to the cursor. */}
          {cut.phase === "end" && cut.from && cutHover && (
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

          {/* Placed endpoint markers. */}
          {cut.from && <circle cx={cut.from.x} cy={cut.from.y} r={unit * 1.3} fill="#1a73e8" pointerEvents="none" />}
          {cut.to && <circle cx={cut.to.x} cy={cut.to.y} r={unit * 1.3} fill="#1a73e8" pointerEvents="none" />}

          {/* Draggable handle to bow the cut into a curve. */}
          {cut.phase === "adjust" && cut.preview && (() => {
            const m = bezierAt(cut.preview, 0.5);
            return (
              <circle
                cx={m.x} cy={m.y} r={unit * 1.8}
                fill="#fff" stroke="#1a73e8" strokeWidth={unit * 0.6}
                style={{ cursor: "grab" }} onMouseDown={onBowDown}
              />
            );
          })()}
        </g>
      )}

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
