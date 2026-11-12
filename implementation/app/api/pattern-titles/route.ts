import { NextResponse } from "next/server";
import { readdir, readFile } from "fs/promises";
import path from "path";

// Display titles of the patterns: { "<file name>": "<name field of the file>" }
// for every pattern definition that has a non-empty string `name`. Patterns
// without one are simply absent (the UI falls back to the file name).

const PATTERNS_DIR = path.join(process.cwd(), "patterndefinitions");

export const dynamic = "force-dynamic";

export async function GET() {
  const titles: Record<string, string> = {};
  try {
    const files = (await readdir(PATTERNS_DIR)).filter((f) => f.endsWith(".json"));
    await Promise.all(
      files.map(async (f) => {
        try {
          const parsed = JSON.parse(await readFile(path.join(PATTERNS_DIR, f), "utf-8")) as { name?: unknown };
          if (typeof parsed.name === "string" && parsed.name.trim()) titles[f.slice(0, -5)] = parsed.name.trim();
        } catch {
          // unreadable / invalid file → no title
        }
      })
    );
  } catch {
    // no patterndefinitions folder yet
  }
  return NextResponse.json(titles);
}
