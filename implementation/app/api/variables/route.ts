import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { parseMeasurementCsv, parseBodyformCsv, type VariableTables } from "@/lib/variableCsv";

// The CSVs are maintained one level above the Next.js app (the project root).
const CSV_DIR = path.join(process.cwd(), "..");
const MEASUREMENT_CSV = path.join(CSV_DIR, "measurement_variables.csv");
const BODYFORM_CSV = path.join(CSV_DIR, "bodyform_variables.csv");

// Always read fresh from disk so manual CSV edits are picked up on each request.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [measurementText, bodyformText] = await Promise.all([
      readFile(MEASUREMENT_CSV, "utf-8"),
      readFile(BODYFORM_CSV, "utf-8"),
    ]);

    const { measurementVariableNames, measurementSets } = parseMeasurementCsv(measurementText);
    const bodyformVariables = parseBodyformCsv(bodyformText);

    const tables: VariableTables = {
      measurementVariableNames,
      measurementSets,
      bodyformVariables,
    };
    return NextResponse.json(tables);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to read/parse variable CSVs: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
