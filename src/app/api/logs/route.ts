import { NextResponse } from "next/server";
import { getLogs } from "@/lib/db";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const from = params.get("from") ?? undefined;
    const to = params.get("to") ?? undefined;
    const stateValue = params.get("state");
    if ((from && !DATE_PATTERN.test(from)) || (to && !DATE_PATTERN.test(to))) {
      return NextResponse.json({ error: "Dates must use YYYY-MM-DD." }, { status: 400 });
    }
    if (from && to && from > to) {
      return NextResponse.json({ error: "The start date must not be after the end date." }, { status: 400 });
    }

    const data = await getLogs({
      uploadId: params.get("uploadId") ?? undefined,
      from,
      to,
      service: params.get("service") ?? undefined,
      state: stateValue === "up" || stateValue === "down" ? stateValue : undefined,
      page: Math.max(Number(params.get("page") ?? 1) || 1, 1),
    });
    return NextResponse.json({ data });
  } catch (error) {
    return apiError(error, "Monitoring logs could not be loaded.");
  }
}
