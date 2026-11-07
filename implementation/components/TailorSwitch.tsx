"use client";

/** Tiny on/off switch for "Tailor mode" (shown at the top of both pages). */
export function TailorSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <label className="tailor-switch" title="Tailor mode: show the edit tools, display settings and inspector">
      <span className="tailor-switch-label">Tailor mode</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`tailor-switch-track${on ? " on" : ""}`}
        onClick={onToggle}
      >
        <span className="tailor-switch-knob" />
      </button>
    </label>
  );
}
