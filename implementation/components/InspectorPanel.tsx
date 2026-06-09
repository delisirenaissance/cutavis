"use client";

import { useState } from "react";
import type { GeometryResult } from "@/lib/geometry";

/** Round to 3 decimals and trim trailing zeros, for compact display. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="inspector-section">
      <button className="inspector-section-head" onClick={() => setOpen((o) => !o)}>
        <span className="inspector-caret">{open ? "▾" : "▸"}</span>
        {title}
        <span className="inspector-count">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

export default function InspectorPanel({ geometry }: { geometry: GeometryResult }) {
  const [collapsed, setCollapsed] = useState(false);

  const variables = Object.entries(geometry.localValues);
  const points = Object.entries(geometry.points);
  const errors = Object.entries(geometry.errors);

  if (collapsed) {
    return (
      <button
        className="inspector-toggle collapsed"
        onClick={() => setCollapsed(false)}
        title="Show inspector"
      >
        <span>Inspector</span>
      </button>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <h2>Inspector</h2>
        <button
          className="inspector-toggle"
          onClick={() => setCollapsed(true)}
          title="Hide inspector"
        >
          ✕
        </button>
      </div>

      {errors.length > 0 && (
        <Section title="Errors" count={errors.length}>
          <table className="inspector-table errors-table">
            <tbody>
              {errors.map(([key, msg]) => (
                <tr key={key}>
                  <td className="k"><code>{key}</code></td>
                  <td className="v">{msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Variables" count={variables.length}>
        {variables.length === 0 ? (
          <p className="inspector-empty">No local variables.</p>
        ) : (
          <table className="inspector-table">
            <tbody>
              {variables.map(([name, value]) => (
                <tr key={name}>
                  <td className="k">{name}</td>
                  <td className="v num">{fmt(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Points" count={points.length}>
        {points.length === 0 ? (
          <p className="inspector-empty">No resolved points.</p>
        ) : (
          <table className="inspector-table">
            <thead>
              <tr><th>point</th><th>x</th><th>y</th></tr>
            </thead>
            <tbody>
              {points.map(([name, p]) => (
                <tr key={name}>
                  <td className="k">{name}</td>
                  <td className="v num">{fmt(p.x)}</td>
                  <td className="v num">{fmt(p.y)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </aside>
  );
}
