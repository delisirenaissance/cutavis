"use client";

import { useEffect, useState } from "react";

interface Props {
  /** Part files that can still be added (already-loaded ones are excluded). */
  availableFiles: string[];
  onAdd: (filename: string) => void;
  onClose: () => void;
}

export function AddPartModal({ availableFiles, onAdd, onClose }: Props) {
  const [selected, setSelected] = useState(availableFiles[0] ?? "");

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasFiles = availableFiles.length > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Add a part to the plot</h3>

        {hasFiles ? (
          <select
            className="set-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {availableFiles.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        ) : (
          <p className="subtitle">All available part files are already loaded.</p>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => onAdd(selected)}
            disabled={!hasFiles || !selected}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
