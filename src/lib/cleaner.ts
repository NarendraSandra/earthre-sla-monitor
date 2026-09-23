import Papa from "papaparse";
import type { CleanCheck, CleanResult, QualityReport } from "./types";

const REQUIRED_HEADERS = [
  "service_id",
  "service_name",
  "timestamp",
  "status_code",
  "latency",
  "latency_unit",
  "agent",
  "region",
] as const;

type RawCheck = Record<(typeof REQUIRED_HEADERS)[number], string>;

function parseTimestamp(value: string): { iso: string; normalized: boolean } | null {
  const trimmed = value.trim();
  let milliseconds: number;
  let normalized = false;

  if (/^\d{10}$/.test(trimmed)) {
    milliseconds = Number(trimmed) * 1_000;
    normalized = true;
  } else if (/^\d{13}$/.test(trimmed)) {
    milliseconds = Number(trimmed);
    normalized = true;
  } else {
    // Reject timezone-less values: interpreting them in the function's local zone
    // would make SLA results deployment-dependent.
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) return null;
    milliseconds = Date.parse(trimmed);
  }

  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), normalized };
}

function addReason(report: QualityReport, row: number, reason: string) {
  report.rejectedRows += 1;
  report.rejectionReasons[reason] = (report.rejectionReasons[reason] ?? 0) + 1;
  if (report.sampleErrors.length < 8) report.sampleErrors.push({ row, reason });
}

function mergeDuplicate(existing: CleanCheck, candidate: CleanCheck): CleanCheck {
  // A duplicate must never make the SLA look healthier. Keep a failed observation
  // over a successful one, then the slower observation as a conservative tie-break.
  const existingRisk = existing.isAvailable ? 0 : 1;
  const candidateRisk = candidate.isAvailable ? 0 : 1;
  const existingLatency = existing.latencyMs ?? -1;
  const candidateLatency = candidate.latencyMs ?? -1;
  const selected =
    candidateRisk > existingRisk ||
    (candidateRisk === existingRisk && candidateLatency > existingLatency)
      ? candidate
      : existing;

  const agents = new Set([existing.agent, candidate.agent]);
  const regions = new Set([existing.region, candidate.region]);
  return {
    ...selected,
    agent: [...agents].sort().join(" + "),
    region: [...regions].sort().join(" + "),
    warnings: [...new Set([...existing.warnings, ...candidate.warnings, "duplicate_consolidated"])],
  };
}

export function cleanCsv(csvText: string): CleanResult {
  const parsed = Papa.parse<RawCheck>(csvText.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  const headers = parsed.meta.fields ?? [];
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length) {
    throw new Error(`Missing required columns: ${missingHeaders.join(", ")}`);
  }

  const report: QualityReport = {
    totalRows: parsed.data.length,
    acceptedRows: 0,
    rejectedRows: 0,
    duplicateRows: 0,
    conflictingDuplicates: 0,
    normalizedTimestamps: 0,
    convertedLatencies: 0,
    missingLatencies: 0,
    nonStandardStatuses: 0,
    rejectionReasons: {},
    sampleErrors: [],
  };

  const parserErrorsByRow = new Map<number, string>();
  for (const error of parsed.errors) {
    const row = (error.row ?? 0) + 2;
    parserErrorsByRow.set(row, `CSV parse error: ${error.message}`);
  }

  const uniqueChecks = new Map<string, CleanCheck>();

  parsed.data.forEach((raw, index) => {
    const sourceRow = index + 2;
    const parserError = parserErrorsByRow.get(sourceRow);
    if (parserError) {
      addReason(report, sourceRow, parserError);
      return;
    }

    const serviceId = (raw.service_id ?? "").trim();
    const serviceName = (raw.service_name ?? "").trim();
    const agent = (raw.agent ?? "").trim();
    const region = (raw.region ?? "").trim();
    if (!serviceId || !serviceName || !agent || !region) {
      addReason(report, sourceRow, "Missing service, agent, or region identity");
      return;
    }

    const timestamp = parseTimestamp(raw.timestamp ?? "");
    if (!timestamp) {
      addReason(report, sourceRow, "Invalid or timezone-less timestamp");
      return;
    }

    const statusCode = Number((raw.status_code ?? "").trim());
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
      addReason(report, sourceRow, "Invalid status code");
      return;
    }

    const warnings: string[] = [];
    if (statusCode > 599) {
      report.nonStandardStatuses += 1;
      warnings.push("non_standard_status");
    }

    const latencyUnit = (raw.latency_unit ?? "").trim().toLowerCase();
    if (latencyUnit !== "ms" && latencyUnit !== "s") {
      addReason(report, sourceRow, "Unsupported latency unit");
      return;
    }

    const latencyValue = (raw.latency ?? "").trim();
    let latencyMs: number | null = null;
    if (!latencyValue) {
      report.missingLatencies += 1;
      warnings.push("missing_latency");
    } else {
      const numericLatency = Number(latencyValue);
      if (!Number.isFinite(numericLatency) || numericLatency < 0) {
        addReason(report, sourceRow, "Invalid latency");
        return;
      }
      latencyMs = latencyUnit === "s" ? numericLatency * 1_000 : numericLatency;
      if (latencyUnit === "s") report.convertedLatencies += 1;
      // Milliseconds are kept to three decimals, enough precision for this source.
      latencyMs = Math.round(latencyMs * 1_000) / 1_000;
    }

    if (timestamp.normalized) report.normalizedTimestamps += 1;
    const check: CleanCheck = {
      serviceId,
      serviceName,
      checkedAt: timestamp.iso,
      statusCode,
      latencyMs,
      agent,
      region,
      isAvailable: statusCode >= 200 && statusCode < 400,
      sourceRow,
      warnings,
    };

    const key = `${serviceId}\u0000${timestamp.iso}`;
    const existing = uniqueChecks.get(key);
    if (existing) {
      report.duplicateRows += 1;
      if (
        existing.statusCode !== check.statusCode ||
        existing.latencyMs !== check.latencyMs ||
        existing.agent !== check.agent ||
        existing.region !== check.region
      ) {
        report.conflictingDuplicates += 1;
      }
      uniqueChecks.set(key, mergeDuplicate(existing, check));
    } else {
      uniqueChecks.set(key, check);
    }
  });

  const records = [...uniqueChecks.values()].sort(
    (a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt),
  );
  report.acceptedRows = records.length;

  return {
    records,
    report,
    rangeStart: records.at(0)?.checkedAt ?? null,
    rangeEnd: records.at(-1)?.checkedAt ?? null,
  };
}
