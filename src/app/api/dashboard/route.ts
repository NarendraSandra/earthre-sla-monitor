import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/db";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const uploadId = new URL(request.url).searchParams.get("uploadId") ?? undefined;
    const data = await getDashboard(uploadId);
    return NextResponse.json({ data });
  } catch (error) {
    return apiError(error, "Dashboard data could not be loaded.");
  }
}
