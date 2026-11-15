import { NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import path from "path";

const PARTS_DIR = path.join(process.cwd(), "patternpartdefinitions");

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
  const filePath = path.join(PARTS_DIR, `${name}.json`);
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
  // Reject if not valid JSON
  try {
    JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  const filePath = path.join(PARTS_DIR, `${name}.json`);
  // Write the text exactly as edited. Re-stringifying would reorder keys:
  // JS objects put integer-like keys ("1", "10") first, so points like "3b"
  // would move behind all plain numbers.
  await writeFile(filePath, body, "utf-8");
  return NextResponse.json({ ok: true });
}
