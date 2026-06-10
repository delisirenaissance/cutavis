import { NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const PATTERNS_DIR = path.join(process.cwd(), "patterndefinitions");

function safeName(name: string): boolean {
  return /^[\w-]+$/.test(name);
}

export async function GET(
  _request: Request,
  { params }: { params: { name: string } }
) {
  const { name } = params;
  if (!safeName(name)) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
  }
  const filePath = path.join(PATTERNS_DIR, `${name}.json`);
  const content = await readFile(filePath, "utf-8");
  return new NextResponse(content, {
    headers: { "Content-Type": "application/json" },
  });
}

export async function PUT(
  request: Request,
  { params }: { params: { name: string } }
) {
  const { name } = params;
  if (!safeName(name)) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
  }
  const body = await request.text();
  // Validate shape: must be JSON with a `parts` array.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { parts?: unknown }).parts)
  ) {
    return NextResponse.json(
      { error: "Pattern must be an object with a `parts` array" },
      { status: 400 }
    );
  }
  await mkdir(PATTERNS_DIR, { recursive: true });
  const filePath = path.join(PATTERNS_DIR, `${name}.json`);
  await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");
  return NextResponse.json({ ok: true });
}
