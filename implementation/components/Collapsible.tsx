"use client";

import type { ReactNode } from "react";

/** A titled section of the left panel that can be collapsed to its header. */
export function Collapsible({
  title,
  open,
  onToggle,
  children,
  hint,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Short text shown next to the title while collapsed. */
  hint?: string;
}) {
  return (
    <section className={`collapsible${open ? " open" : ""}`}>
      <button className="collapsible-head" onClick={onToggle} aria-expanded={open}>
        <span className="collapsible-arrow" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="collapsible-title">{title}</span>
        {!open && hint && <span className="collapsible-hint">{hint}</span>}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}
