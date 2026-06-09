"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  currentFile: string; // empty string → no file loaded yet
  onSave: (filename: string) => Promise<void>;
  onClose: () => void;
}

export function SaveModal({ currentFile, onSave, onClose }: Props) {
  const [mode, setMode] = useState<"overwrite" | "new">(
    currentFile ? "overwrite" : "new"
  );
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus the name input when switching to "new" mode
  useEffect(() => {
    if (mode === "new") nameInputRef.current?.focus();
  }, [mode]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    const filename = mode === "overwrite" ? currentFile : newName.trim();
    if (!filename) {
      setError("Please enter a file name.");
      return;
    }
    if (!/^[\w-]+$/.test(filename)) {
      setError("Name may only contain letters, digits, hyphens, and underscores.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(filename);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Save part definition</h3>

        <div className="modal-options">
          {currentFile && (
            <label className="radio-row">
              <input
                type="radio"
                name="save-mode"
                checked={mode === "overwrite"}
                onChange={() => setMode("overwrite")}
              />
              Overwrite &ldquo;{currentFile}&rdquo;
            </label>
          )}

          <label className="radio-row">
            <input
              type="radio"
              name="save-mode"
              checked={mode === "new"}
              onChange={() => setMode("new")}
            />
            Save as new file
          </label>

          {mode === "new" && (
            <input
              ref={nameInputRef}
              className="modal-name-input"
              type="text"
              placeholder="filename (without .json)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
          )}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
