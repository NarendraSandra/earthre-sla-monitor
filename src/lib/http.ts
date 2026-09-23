import { NextResponse } from "next/server";
import { DatabaseConfigurationError } from "@/lib/db";

export function apiError(error: unknown, fallback: string) {
  if (error instanceof DatabaseConfigurationError) {
    return NextResponse.json(
      {
        error: "Database is not connected yet.",
        code: "DATABASE_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
