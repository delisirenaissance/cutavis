// Print a pattern at 100 % scale (geometry units are cm) to a tiled PDF.
//
// The pattern is laid on a grid of tiles, one per sheet. Each tile is the
// printable area of the page (page size minus the margin on every side), so
// sheets can be trimmed along the printed frame and assembled edge-to-edge.
// Page 1 is an overview: info, a 5×5 cm test square to verify the print scale,
// and an assembly map of the tiles.
//
// The PDF is written directly (no dependency): our geometry is cubic Béziers,
// which PDF draws natively with the `c` operator, so curves stay exact vectors.
// Text uses the standard Helvetica fonts (no embedding needed).

import type { GeometryResult } from "./geometry";
import { seamAllowanceOutline } from "./allowance";

export type PaperFormat = "A4" | "A3" | "Letter";
export type Orientation = "portrait" | "landscape";

export interface PrintSettings {
  format: PaperFormat;
  orientation: Orientation;
  /** Distance of the printable area from the page border, in mm (5–15). */
  marginMm: number;
}

/** Portrait page sizes in mm. */
export const PAPER_MM: Record<PaperFormat, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  Letter: [215.9, 279.4],
};

export const MIN_MARGIN_MM = 5;
export const MAX_MARGIN_MM = 15;

export interface PrintPiece {
  id: string;
  geometry: GeometryResult;
}

export interface PrintOptions {
  showAuxLines: boolean;
  showPoints: boolean;
  /** Draw the seam-allowance polygon (the cutting line) around each piece. */
  showAllowance: boolean;
}

// ── Geometry extraction ───────────────────────────────────────────────────────

type P = { x: number; y: number };
/** One drawable path: a start point plus cubic segments [c1, c2, end]. */
interface DrawPath {
  start: P;
  curves: [P, P, P][];
  aux: boolean;
}

const NUM_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

/** Parse our "M x y C x y x y x y [C …]" path strings. */
function parsePath(d: string): { start: P; curves: [P, P, P][] } | null {
  const v = (d.match(NUM_RE) ?? []).map(Number);
  if (v.length < 8) return null;
  const start = { x: v[0], y: v[1] };
  const curves: [P, P, P][] = [];
  for (let i = 2; i + 5 < v.length; i += 6) {
    curves.push([
      { x: v[i], y: v[i + 1] },
      { x: v[i + 2], y: v[i + 3] },
      { x: v[i + 4], y: v[i + 5] },
    ]);
  }
  return { start, curves };
}

/** The lines that are drawn (mirrors the screen: aux lines only when shown). */
function visiblePaths(pieces: PrintPiece[], opts: PrintOptions): DrawPath[] {
  const out: DrawPath[] = [];
  for (const pc of pieces) {
    for (const [name, d] of Object.entries(pc.geometry.paths)) {
      const aux = pc.geometry.lineTypes[name] === "aux";
      if (aux && !opts.showAuxLines) continue;
      const p = parsePath(d);
      if (p) out.push({ ...p, aux });
    }
  }
  return out;
}

function visiblePoints(pieces: PrintPiece[], opts: PrintOptions): { name: string; p: P }[] {
  const out: { name: string; p: P }[] = [];
  for (const pc of pieces) {
    for (const [name, rp] of Object.entries(pc.geometry.points)) {
      if (rp.pointType === "marker" || opts.showPoints) out.push({ name, p: { x: rp.x, y: rp.y } });
    }
  }
  return out;
}

function bezAt(a: P, b: P, c: P, d: P, t: number): P {
  const m = 1 - t;
  return {
    x: m * m * m * a.x + 3 * m * m * t * b.x + 3 * m * t * t * c.x + t * t * t * d.x,
    y: m * m * m * a.y + 3 * m * m * t * b.y + 3 * m * t * t * c.y + t * t * t * d.y,
  };
}

/** Dense samples along every path (≤ 2 mm apart) — used for the bounds and to
 *  find which tiles contain any ink. */
function samplePaths(paths: DrawPath[]): P[] {
  const pts: P[] = [];
  for (const dp of paths) {
    let a = dp.start;
    for (const [b, c, d] of dp.curves) {
      const approxLen =
        Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
      const n = Math.max(8, Math.ceil(approxLen / 0.2));
      for (let k = 0; k <= n; k++) pts.push(bezAt(a, b, c, d, k / n));
      a = d;
    }
  }
  return pts;
}

/** Seam-allowance polygons of all pieces (empty when switched off). */
function allowancePolys(pieces: PrintPiece[], opts: PrintOptions): P[][] {
  if (!opts.showAllowance) return [];
  const out: P[][] = [];
  for (const pc of pieces) {
    const poly = seamAllowanceOutline(pc.geometry);
    if (poly) out.push(poly);
  }
  return out;
}

/** Points along a closed polygon, ≤ 2 mm apart (for bounds / ink detection). */
function densify(poly: P[]): P[] {
  const pts: P[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2));
    for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return pts;
}

// ── Tile layout ───────────────────────────────────────────────────────────────

export interface Tile {
  row: number;
  col: number;
  label: string; // e.g. "B3"
  /** Top-left corner of the tile in pattern coordinates (cm). */
  x0: number;
  y0: number;
  hasInk: boolean;
}

export interface TileLayout {
  pageWmm: number;
  pageHmm: number;
  /** Printable area per sheet, in cm. */
  areaW: number;
  areaH: number;
  rows: number;
  cols: number;
  /** Top-left of tile A1 in pattern coordinates (cm); the pattern is centred
   *  in the tile grid. */
  minX: number;
  minY: number;
  /** Size of the drawn pattern itself (cm). */
  patternW: number;
  patternH: number;
  tiles: Tile[];
}

const rowName = (r: number): string =>
  r < 26 ? String.fromCharCode(65 + r) : rowName(Math.floor(r / 26) - 1) + String.fromCharCode(65 + (r % 26));

export function pageSizeMm(s: PrintSettings): [number, number] {
  const [w, h] = PAPER_MM[s.format];
  return s.orientation === "portrait" ? [w, h] : [h, w];
}

/** Lay the visible pattern out on page-sized tiles. Null if nothing to print. */
export function layoutTiles(pieces: PrintPiece[], s: PrintSettings, opts: PrintOptions): TileLayout | null {
  const samples = samplePaths(visiblePaths(pieces, opts));
  for (const poly of allowancePolys(pieces, opts)) samples.push(...densify(poly));
  for (const v of visiblePoints(pieces, opts)) samples.push(v.p);
  if (samples.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of samples) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const patternW = maxX - minX;
  const patternH = maxY - minY;

  const [pageWmm, pageHmm] = pageSizeMm(s);
  const areaW = (pageWmm - 2 * s.marginMm) / 10;
  const areaH = (pageHmm - 2 * s.marginMm) / 10;
  // Grid from the pattern's real size (plus a 1 mm minimum clearance so the
  // outermost lines never sit on the trim frame), then centre the pattern in
  // the grid so the spare space is split evenly around it.
  const clear = 0.1;
  const cols = Math.max(1, Math.ceil((patternW + 2 * clear) / areaW - 1e-9));
  const rows = Math.max(1, Math.ceil((patternH + 2 * clear) / areaH - 1e-9));
  minX -= (cols * areaW - patternW) / 2;
  minY -= (rows * areaH - patternH) / 2;

  const ink = new Set<string>();
  for (const p of samples) {
    const c = Math.min(cols - 1, Math.floor((p.x - minX) / areaW));
    const r = Math.min(rows - 1, Math.floor((p.y - minY) / areaH));
    ink.add(`${r},${c}`);
  }

  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        row: r, col: c, label: `${rowName(r)}${c + 1}`,
        x0: minX + c * areaW, y0: minY + r * areaH,
        hasInk: ink.has(`${r},${c}`),
      });
    }
  }
  return { pageWmm, pageHmm, areaW, areaH, rows, cols, minX, minY, patternW, patternH, tiles };
}

// ── Minimal PDF writer ────────────────────────────────────────────────────────

const PT_PER_MM = 72 / 25.4;
const PT_PER_CM = 72 / 2.54;

const f = (n: number): string => {
  const s = n.toFixed(3);
  return s.includes(".") ? s.replace(/\.?0+$/, "") || "0" : s;
};

/** Escape a string for a PDF literal; non-Latin-1 characters become "?". */
function pdfText(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "(" || ch === ")") out += "\\" + ch;
    else if (code === 0x2013 || code === 0x2014) out += "-";
    else if (code === 0x00d7) out += "x";
    else out += code < 256 ? ch : "?";
  }
  return out;
}

/** Rough Helvetica text width (avg glyph ≈ 0.52 em) for centering labels. */
const textW = (s: string, size: number) => s.length * size * 0.52;

/** Greedy word-wrap to a maximum width (using the rough width estimate). */
function wrapText(s: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && textW(next, size) > maxW) { out.push(line); line = `  ${word}`; }
    else line = next;
  }
  if (line) out.push(line);
  return out;
}

class Content {
  ops: string[] = [];
  push(...o: string[]) { this.ops.push(...o); }
  text(x: number, y: number, size: number, s: string, bold = false, gray = 0) {
    this.push(`BT /${bold ? "F2" : "F1"} ${f(size)} Tf ${f(gray)} g ${f(x)} ${f(y)} Td (${pdfText(s)}) Tj ET`);
  }
  rect(x: number, y: number, w: number, h: number, op: "S" | "f" | "B") {
    this.push(`${f(x)} ${f(y)} ${f(w)} ${f(h)} re ${op}`);
  }
  circle(cx: number, cy: number, r: number, op: "S" | "f") {
    const k = 0.5523 * r;
    this.push(
      `${f(cx + r)} ${f(cy)} m`,
      `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
      `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
      `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
      `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c ${op}`
    );
  }
  toString() { return this.ops.join("\n"); }
}

/** Assemble the PDF file from page content streams (all pages same size). */
function writePdf(pages: string[], pageWpt: number, pageHpt: number, title: string): Uint8Array<ArrayBuffer> {
  const objs: string[] = [];
  // 1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold, 5 Info, then page/content pairs.
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  objs[5] = `<< /Title (${pdfText(title)}) /Producer (cutavis) >>`;
  pages.forEach((content, i) => {
    const pid = pageIds[i];
    objs[pid] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pageWpt)} ${f(pageHpt)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pid + 1} 0 R >>`;
    objs[pid + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Every character is < 256 (content is ASCII, text escaped to Latin-1), so
  // the string length equals the byte length used for the xref offsets.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

// ── Page drawing ──────────────────────────────────────────────────────────────

/** Emit the pattern's paths/points/labels through a coordinate mapping. */
function drawPattern(
  c: Content,
  pieces: PrintPiece[],
  paths: DrawPath[],
  opts: PrintOptions,
  map: (p: P) => P,
  scalePt: number, // points per cm (for sizes that should scale with the drawing)
  detailed: boolean,
  allowances: P[][]
) {
  c.push("1 J 1 j"); // round caps/joins

  // Seam allowance = the cutting line: solid.
  c.push(`0 G ${f(detailed ? 0.8 : 0.4)} w [] 0 d`);
  for (const poly of allowances) {
    poly.forEach((p, i) => {
      const q = map(p);
      c.push(`${f(q.x)} ${f(q.y)} ${i === 0 ? "m" : "l"}`);
    });
    c.push("h S");
  }

  // Pattern (seam) lines: dashed on the tile pages; aux lines dash-dot grey.
  // The small overview map draws them as thin solid grey lines instead.
  for (const aux of [true, false]) {
    if (aux) c.push(`0.6 G ${f(detailed ? 0.4 : 0.25)} w ${detailed ? "[4 1.5 0.8 1.5] 0 d" : "[] 0 d"}`);
    else c.push(detailed ? "0 G 0.6 w [4 2.5] 0 d" : "0.45 G 0.3 w [] 0 d");
    for (const dp of paths) {
      if (dp.aux !== aux) continue;
      const s = map(dp.start);
      c.push(`${f(s.x)} ${f(s.y)} m`);
      for (const [b, cc, d] of dp.curves) {
        const B = map(b), C = map(cc), D = map(d);
        c.push(`${f(B.x)} ${f(B.y)} ${f(C.x)} ${f(C.y)} ${f(D.x)} ${f(D.y)} c`);
      }
      c.push("S");
    }
  }
  c.push("[] 0 d");
  if (!detailed) return;

  // Points (marker always; aux points if "show points" is on), as on screen.
  for (const { name, p } of visiblePoints(pieces, opts)) {
    const q = map(p);
    c.push("0.85 0.26 0.1 rg");
    c.circle(q.x, q.y, 0.06 * scalePt, "f");
    c.text(q.x + 3, q.y + 3, 6, name, false, 0.25);
  }
  // Piece name at the centre of each piece's bounds.
  for (const pc of pieces) {
    const b = pc.geometry.bbox;
    if (!b) continue;
    const q = map({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    c.text(q.x - textW(pc.id, 10) / 2, q.y, 10, pc.id, true, 0.15);
  }
}

export interface PdfMeta {
  title: string;
  /** Extra info lines for the overview page (pattern, measurements, …). */
  info: string[];
}

/** Build the tiled 1:1 PDF. Returns null if there is nothing to print. */
export function buildPatternPdf(
  pieces: PrintPiece[],
  s: PrintSettings,
  opts: PrintOptions,
  meta: PdfMeta
): { bytes: Uint8Array<ArrayBuffer>; pages: number } | null {
  const lay = layoutTiles(pieces, s, opts);
  if (!lay) return null;
  const paths = visiblePaths(pieces, opts);
  const allowances = allowancePolys(pieces, opts);
  const W = lay.pageWmm * PT_PER_MM;
  const H = lay.pageHmm * PT_PER_MM;
  const m = s.marginMm * PT_PER_MM;
  const aw = lay.areaW * PT_PER_CM;
  const ah = lay.areaH * PT_PER_CM;
  const printed = lay.tiles.filter((t) => t.hasInk);
  const total = printed.length + 1;
  const pages: string[] = [];

  // ── Overview page ──
  {
    const c = new Content();
    let y = H - m - 18;
    c.text(m, y, 16, meta.title, true);
    y -= 18;
    const facts = [
      ...meta.info,
      `Paper: ${s.format} ${s.orientation}, margin ${s.marginMm} mm - ` +
        `${lay.cols} x ${lay.rows} tiles, ${printed.length} printed page${printed.length === 1 ? "" : "s"} + this overview`,
      `Pattern size: ${lay.patternW.toFixed(1)} x ${lay.patternH.toFixed(1)} cm, printed at 100 % (1:1).`,
      `Print at "Actual size" / 100 % (no "fit to page"), then check the 5 cm test square.`,
      `Trim each sheet along its frame and join tiles edge to edge as in the map below.`,
      opts.showAllowance
        ? `Solid line = cutting line (incl. seam allowance), dashed line = seam line.`
        : `Dashed line = seam line (no seam allowance included - add it when cutting).`,
    ];
    for (const line of facts) {
      for (const part of wrapText(line, 9, W - 2 * m)) { c.text(m, y, 9, part); y -= 12; }
    }

    // 5 × 5 cm test square.
    const sq = 5 * PT_PER_CM;
    y -= 8;
    c.push("0 G 0.8 w");
    c.rect(m, y - sq, sq, sq, "S");
    c.text(m + sq + 8, y - sq / 2 + 6, 10, "5 cm x 5 cm", true);
    c.text(m + sq + 8, y - sq / 2 - 7, 8, "Measure this square to verify the print scale.");
    y -= sq + 22;

    // Assembly map, scaled to fit the remaining area.
    c.text(m, y, 10, "Assembly map", true);
    y -= 10;
    const gridW = lay.cols * aw;
    const gridH = lay.rows * ah;
    const availW = W - 2 * m;
    const availH = y - m;
    const k = Math.min(availW / gridW, availH / gridH);
    if (k > 0) {
      const ox = m + (availW - gridW * k) / 2;
      const oy = y; // top edge of the map
      for (const t of lay.tiles) {
        const x = ox + t.col * aw * k;
        const yy = oy - (t.row + 1) * ah * k;
        if (t.hasInk) c.push("1 g"); else c.push("0.9 g");
        c.push("0.7 G 0.5 w");
        c.rect(x, yy, aw * k, ah * k, "B");
        const lbl = t.hasInk ? t.label : `${t.label} (blank, not printed)`;
        const size = Math.max(5, Math.min(14, aw * k * 0.12));
        c.text(x + 3, yy + ah * k - size - 2, size, lbl, true, t.hasInk ? 0.55 : 0.7);
      }
      const map = (p: P): P => ({
        x: ox + (p.x - lay.minX) * PT_PER_CM * k,
        y: oy - (p.y - lay.minY) * PT_PER_CM * k,
      });
      drawPattern(c, pieces, paths, opts, map, PT_PER_CM * k, false, allowances);
    }
    pages.push(c.toString());
  }

  // ── One page per tile with content ──
  printed.forEach((t, i) => {
    const c = new Content();
    // Pattern coordinates (cm, y down) → page points (y up), tile at the area.
    const map = (p: P): P => ({
      x: m + (p.x - t.x0) * PT_PER_CM,
      y: H - m - (p.y - t.y0) * PT_PER_CM,
    });
    // Clip to the printable area so nothing spills into the margin.
    c.push("q", `${f(m)} ${f(H - m - ah)} ${f(aw)} ${f(ah)} re W n`);
    drawPattern(c, pieces, paths, opts, map, PT_PER_CM, true, allowances);
    c.push("Q");

    // Frame (trim line) and labels.
    // Dotted frame: zero-length dashes with round caps print as dots.
    c.push("0.45 G 0.6 w 1 J [0 2.2] 0 d");
    c.rect(m, H - m - ah, aw, ah, "S");
    c.push("[] 0 d");
    c.text(m + 4, H - m - 16, 13, t.label, true, 0.6);
    const neighbours = [
      t.row > 0 ? `above ${rowName(t.row - 1)}${t.col + 1}` : "",
      t.col > 0 ? `left ${rowName(t.row)}${t.col}` : "",
      t.col < lay.cols - 1 ? `right ${rowName(t.row)}${t.col + 2}` : "",
      t.row < lay.rows - 1 ? `below ${rowName(t.row + 1)}${t.col + 1}` : "",
    ].filter(Boolean).join(", ");
    const footer = `${meta.title} - tile ${t.label} (row ${rowName(t.row)}, column ${t.col + 1})` +
      `${neighbours ? ` - ${neighbours}` : ""} - page ${i + 2}/${total} - 100 %`;
    const fs = Math.min(6.5, Math.max(4, m * 0.45), (W - 2 * m) / (footer.length * 0.52));
    c.text(m, Math.max(2, (m - fs) / 2), fs, footer, false, 0.4);
    pages.push(c.toString());
  });

  return { bytes: writePdf(pages, W, H, meta.title), pages: pages.length };
}
