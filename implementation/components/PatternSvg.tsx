import type { GeometryResult, ResolvedPoint } from "@/lib/geometry";

interface Props {
  geometry: GeometryResult;
  showAuxLines: boolean;
  showPoints: boolean;
  /** Optional map from a (possibly prefixed) point key to the label to draw.
   *  Used when several parts are merged so labels stay as bare point names. */
  pointLabels?: Record<string, string>;
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

export function PatternSvg({ geometry, showAuxLines, showPoints, pointLabels }: Props) {
  const { bbox, paths, lineTypes, points } = geometry;

  if (!bbox) {
    return (
      <div className="subtitle">No points to display — fix the formulas on the left.</div>
    );
  }

  const pad = Math.max((bbox.maxX - bbox.minX) * 0.1, (bbox.maxY - bbox.minY) * 0.1, 5);
  const x = bbox.minX - pad;
  const y = bbox.minY - pad;
  const w = bbox.maxX - bbox.minX + pad * 2;
  const h = bbox.maxY - bbox.minY + pad * 2;
  const unit = Math.max(w, h) / 200;

  // Decide which points to render: markers always, others only when showPoints is on
  const visiblePoints = Object.entries(points).filter(
    ([, p]) => p.pointType === "marker" || showPoints
  );

  return (
    <svg viewBox={`${x} ${y} ${w} ${h}`} width={w * 8} height={h * 8} role="img">
      {Object.entries(paths).map(([name, d]) => {
        const lt = lineTypes[name];
        if (lt === "aux" && !showAuxLines) return null;

        const isAux = lt === "aux";
        return (
          <path
            key={name}
            d={d}
            fill="none"
            stroke={isAux ? "#999" : "#111"}
            strokeWidth={isAux ? unit * 0.6 : unit * 1.0}
            strokeDasharray={isAux ? `${unit * 3} ${unit * 2}` : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}

      {visiblePoints.map(([name, p]) => {
        const { dx, dy, anchor } = labelProps(p, unit);
        return (
          <g key={name}>
            <circle cx={p.x} cy={p.y} r={unit * 1} fill="#d8431b" />
            <text
              x={p.x + dx}
              y={p.y + dy}
              fontSize={unit * 4}
              fill="#333"
              fontFamily="monospace"
              textAnchor={anchor}
            >
              {pointLabels?.[name] ?? name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
