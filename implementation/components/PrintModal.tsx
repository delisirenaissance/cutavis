"use client";

import { useEffect, useMemo, useState } from "react";
import {
  layoutTiles,
  MAX_MARGIN_MM,
  MIN_MARGIN_MM,
  type PaperFormat,
  type PrintOptions,
  type PrintPiece,
  type PrintSettings,
} from "@/lib/pdf";

interface Props {
  pieces: PrintPiece[];
  options: PrintOptions;
  initial: PrintSettings;
  /** Build and download the PDF; may throw to show an error. */
  onCreate: (settings: PrintSettings) => void;
  onClose: () => void;
}

const FORMATS: { value: PaperFormat; label: string }[] = [
  { value: "A4", label: "A4 (210 × 297 mm)" },
  { value: "A3", label: "A3 (297 × 420 mm)" },
  { value: "Letter", label: "Letter (8.5 × 11 in)" },
];

export function PrintModal({ pieces, options, initial, onCreate, onClose }: Props) {
  const [settings, setSettings] = useState<PrintSettings>(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layout = useMemo(() => layoutTiles(pieces, settings, options), [pieces, settings, options]);
  const printedPages = layout ? layout.tiles.filter((t) => t.hasInk).length : 0;

  function handleCreate() {
    setError(null);
    try {
      onCreate(settings);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal print-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Print to PDF (100 % scale)</h3>

        <div className="modal-options">
          <div className="print-field">
            <span className="print-label">Page format</span>
            {FORMATS.map((fm) => (
              <label key={fm.value} className="radio-row">
                <input
                  type="radio"
                  name="print-format"
                  checked={settings.format === fm.value}
                  onChange={() => setSettings((s) => ({ ...s, format: fm.value }))}
                />
                {fm.label}
              </label>
            ))}
          </div>

          <div className="print-field">
            <span className="print-label">Orientation</span>
            {(["portrait", "landscape"] as const).map((o) => (
              <label key={o} className="radio-row">
                <input
                  type="radio"
                  name="print-orientation"
                  checked={settings.orientation === o}
                  onChange={() => setSettings((s) => ({ ...s, orientation: o }))}
                />
                {o === "portrait" ? "Portrait" : "Landscape"}
              </label>
            ))}
          </div>

          <div className="print-field">
            <label className="print-label" htmlFor="print-margin">
              Margin to page border: <strong>{settings.marginMm} mm</strong>
            </label>
            <input
              id="print-margin"
              type="range"
              min={MIN_MARGIN_MM}
              max={MAX_MARGIN_MM}
              step={1}
              value={settings.marginMm}
              onChange={(e) => setSettings((s) => ({ ...s, marginMm: Number(e.target.value) }))}
            />
            <div className="print-range-ends">
              <span>{MIN_MARGIN_MM} mm</span>
              <span>{MAX_MARGIN_MM} mm</span>
            </div>
          </div>

          <p className="print-summary">
            {layout
              ? `Pattern ${layout.patternW.toFixed(1)} × ${layout.patternH.toFixed(1)} cm → ` +
                `${layout.cols} × ${layout.rows} tiles of ${layout.areaW.toFixed(1)} × ${layout.areaH.toFixed(1)} cm; ` +
                `${printedPages} page${printedPages === 1 ? "" : "s"} with content + 1 overview page ` +
                `(test square & assembly map).`
              : "Nothing to print."}
          </p>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleCreate} disabled={!layout}>
            Create PDF now
          </button>
        </div>
      </div>
    </div>
  );
}
