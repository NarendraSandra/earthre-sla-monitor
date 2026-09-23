import { NextResponse } from "next/server";
import { cleanCsv } from "@/lib/cleaner";
import { DatabaseConfigurationError, saveUpload } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a CSV file to upload." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: "Only .csv files are accepted." }, { status: 415 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "The selected file is empty." }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "CSV files must be 4 MB or smaller for this Vercel function." },
        { status: 413 },
      );
    }

    const result = cleanCsv(await file.text());
    if (!result.records.length) {
      return NextResponse.json(
        { error: "No valid monitoring checks remained after validation.", report: result.report },
        { status: 422 },
      );
    }

    const uploadId = await saveUpload(file.name.slice(0, 240), result);
    return NextResponse.json(
      {
        uploadId,
        report: result.report,
        rangeStart: result.rangeStart,
        rangeEnd: result.rangeEnd,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) {
      return NextResponse.json(
        { error: "Connect a Postgres database before uploading.", code: "DATABASE_NOT_CONFIGURED" },
        { status: 503 },
      );
    }
    if (error instanceof Error && error.message.startsWith("Missing required columns:")) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error(error);
    return NextResponse.json({ error: "The upload could not be processed." }, { status: 500 });
  }
}
