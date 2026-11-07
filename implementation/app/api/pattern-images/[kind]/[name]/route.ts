import { readFile } from "fs/promises";
import path from "path";

// Product pictures for the start page:
//   /api/pattern-images/design/<name>    → patterndesigns/<name>Design.png
//   /api/pattern-images/thumbnail/<name> → patternthumbnails/<name>Thumbnail.png
// Responds 404 when the picture doesn't exist (the start page then shows a
// placeholder).

const SOURCES: Record<string, { dir: string; suffix: string }> = {
  design: { dir: "patterndesigns", suffix: "Design.png" },
  thumbnail: { dir: "patternthumbnails", suffix: "Thumbnail.png" },
};

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { kind: string; name: string } }
) {
  const src = SOURCES[params.kind];
  const name = decodeURIComponent(params.name);
  // Only plain pattern names — no path traversal.
  if (!src || !/^[\w-]+$/.test(name)) return new Response("Not found", { status: 404 });
  try {
    const file = await readFile(path.join(process.cwd(), src.dir, `${name}${src.suffix}`));
    return new Response(new Uint8Array(file), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
