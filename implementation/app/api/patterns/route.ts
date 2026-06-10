import { NextResponse } from "next/server";
import { readdir } from "fs/promises";
import path from "path";

const PATTERNS_DIR = path.join(process.cwd(), "patterndefinitions");

export async function GET() {
  try {
    const files = await readdir(PATTERNS_DIR);
    const names = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5)); // strip .json
    return NextResponse.json(names);
  } catch {
    // Directory doesn't exist yet (no pattern has been saved) — return empty list.
    return NextResponse.json([]);
  }
}
