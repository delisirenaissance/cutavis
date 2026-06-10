"use client";

import { useEffect, useRef, useState } from "react";
import type { GeometryResult, ResolvedPoint } from "@/lib/geometry";

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
  /** Called with a part id to select, or null to clear the selection. */
  onSelectPart: (id: string | null) => void;
  /** Called once when a drag ends, with the net offset in geometry units. */
  onMovePart: (id: string, dx: number, dy: number) => void;
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
  onSelectPart,
  onMovePart,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

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
    e.preventDefault();
    e.stopPropagation();
    onSelectPart(id);
    setDrag({ id, startClientX: e.clientX, startClientY: e.clientY, dx: 0, dy: 0, moved: false });
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
      {/* Background: clicking empty space clears the selection. */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="transparent"
        onMouseDown={() => onSelectPart(null)}
      />

      {parts.map((part) => {
        const g = part.geometry;
        const isSelected = part.id === selectedPart;
        const isDragging = drag?.id === part.id;
        const tx = isDragging ? drag!.dx : 0;
        const ty = isDragging ? drag!.dy : 0;

        const visiblePoints = Object.entries(g.points).filter(
          ([, p]) => p.pointType === "marker" || showPoints
        );

        return (
          <g
            key={part.id}
            transform={tx || ty ? `translate(${tx} ${ty})` : undefined}
            onMouseDown={(e) => startDrag(e, part.id)}
            style={{ cursor: isDragging ? "grabbing" : "grab" }}
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
                    stroke={isSelected ? "#d8431b" : isAux ? "#999" : "#111"}
                    strokeWidth={isAux ? unit * 0.6 : unit * 1.0}
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
    </svg>
  );
}
