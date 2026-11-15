// Part JSON is kept as the user wrote it. JSON.parse → JSON.stringify must be
// avoided: JS objects put integer-like keys ("1", "2", "10") first, in numeric
// order, so points like "3b" / "27a" would be moved behind all plain numbers.

/**
 * Set one entry of `part_specific_user_definable_variables` directly in the
 * JSON text, leaving everything else (key order, formatting) untouched.
 * Returns null if the text can't be patched safely (caller falls back).
 */
export function setUserVariableInText(text: string, name: string, value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const block = /("part_specific_user_definable_variables"\s*:\s*\{)([^{}]*)(\})/.exec(text);
  if (!block) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entry = new RegExp(`("${esc}"\\s*:\\s*)(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`);
  if (!entry.test(block[2])) return null;
  const body = block[2].replace(entry, (_, k: string) => `${k}${value}`);
  const out = text.slice(0, block.index) + block[1] + body + block[3] + text.slice(block.index + block[0].length);
  // Verify: still valid JSON and the value really changed.
  try {
    const parsed = JSON.parse(out);
    return parsed?.part_specific_user_definable_variables?.[name] === value ? out : null;
  } catch {
    return null;
  }
}

/** Validate part JSON text and return it unchanged (throws if invalid). */
export function checkedPartText(raw: string): string {
  JSON.parse(raw);
  return raw;
}
