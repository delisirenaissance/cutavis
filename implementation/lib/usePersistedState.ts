"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Drop-in replacement for useState that mirrors the value in localStorage.
 *
 * - First render always uses `defaultValue` (avoids SSR/hydration mismatch).
 * - After mount, the stored value (if any) is read and applied.
 * - Every state change is written back to localStorage automatically.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(defaultValue);

  // On mount: load persisted value (runs only in the browser)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // Corrupt storage entry – ignore and keep the default.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On every change: persist the new value
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or unavailable – ignore silently.
    }
  }, [key, value]);

  return [value, setValue];
}
