import { NextResponse } from "next/server";
import { readdir } from "fs/promises";
import path from "path";

const PARTS_DIR = path.join(process.cwd(), "patternpartdefinitions");

export async function GET() {
  const files = await readdir(PARTS_DIR);
  const names = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5)); // strip .json
  return NextResponse.json(names);
}
