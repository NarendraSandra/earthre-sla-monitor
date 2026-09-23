import { neon } from "@neondatabase/serverless";
import type {
  CleanResult,
  DashboardPayload,
  DailyPoint,
  LogRecord,
  LogsPayload,
  QualityReport,
  ServiceSummary,
  UploadSummary,
} from "@/lib/types";

export class DatabaseConfigurationError extends Error {
  constructor() {
    super("DATABASE_URL is not configured");
    this.name = "DatabaseConfigurationError";
  }
}

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new DatabaseConfigurationError();
  return neon(url);
}

let schemaPromise: Promise<void> | null = null;

export function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = database();
      await sql`
        CREATE TABLE IF NOT EXISTS upload_batches (
          id uuid PRIMARY KEY,
          file_name text NOT NULL,
          uploaded_at timestamptz NOT NULL DEFAULT now(),
          total_rows integer NOT NULL,
          accepted_rows integer NOT NULL,
          rejected_rows integer NOT NULL,
          duplicate_rows integer NOT NULL,
          range_start timestamptz,
          range_end timestamptz,
          quality_report jsonb NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS service_checks (
          id bigserial PRIMARY KEY,
          upload_id uuid NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
          service_id text NOT NULL,
          service_name text NOT NULL,
          checked_at timestamptz NOT NULL,
          status_code integer NOT NULL,
          latency_ms double precision,
          agent text NOT NULL,
          region text NOT NULL,
          is_available boolean NOT NULL,
          source_row integer NOT NULL,
          warnings text[] NOT NULL DEFAULT '{}',
          UNIQUE (upload_id, service_id, checked_at)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS service_checks_upload_time_idx
        ON service_checks (upload_id, checked_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS service_checks_upload_service_idx
        ON service_checks (upload_id, service_id)
      `;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export async function saveUpload(fileName: string, result: CleanResult) {
  await ensureSchema();
  const sql = database();
  const uploadId = crypto.randomUUID();
  const queries = [
    sql.query(
      `INSERT INTO upload_batches (
        id, file_name, total_rows, accepted_rows, rejected_rows,
        duplicate_rows, range_start, range_end, quality_report
      ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::jsonb)`,
      [
        uploadId,
        fileName,
        result.report.totalRows,
        result.report.acceptedRows,
        result.report.rejectedRows,
        result.report.duplicateRows,
        result.rangeStart,
        result.rangeEnd,
        JSON.stringify(result.report),
      ],
    ),
  ];

  for (let offset = 0; offset < result.records.length; offset += 750) {
    const chunk = result.records.slice(offset, offset + 750).map((record) => ({
      service_id: record.serviceId,
      service_name: record.serviceName,
      checked_at: record.checkedAt,
      status_code: record.statusCode,
      latency_ms: record.latencyMs,
      agent: record.agent,
      region: record.region,
      is_available: record.isAvailable,
      source_row: record.sourceRow,
      warnings: record.warnings,
    }));
    queries.push(
      sql.query(
        `INSERT INTO service_checks (
          upload_id, service_id, service_name, checked_at, status_code,
          latency_ms, agent, region, is_available, source_row, warnings
        )
        SELECT $1::uuid, x.service_id, x.service_name, x.checked_at::timestamptz,
          x.status_code, x.latency_ms, x.agent, x.region, x.is_available,
          x.source_row, x.warnings
        FROM jsonb_to_recordset($2::jsonb) AS x(
          service_id text, service_name text, checked_at text, status_code integer,
          latency_ms double precision, agent text, region text, is_available boolean,
          source_row integer, warnings text[]
        )`,
        [uploadId, JSON.stringify(chunk)],
      ),
    );
  }

  await sql.transaction(queries);
  return uploadId;
}

type UploadRow = UploadSummary & { quality?: QualityReport };

function asNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function listUploadRows(includeQuality = false): Promise<UploadRow[]> {
  await ensureSchema();
  const sql = database();
  const rows = await sql.query(
    `SELECT id::text,
      file_name AS "fileName",
      uploaded_at::text AS "uploadedAt",
      accepted_rows AS "acceptedRows",
      rejected_rows AS "rejectedRows",
      range_start::text AS "rangeStart",
      range_end::text AS "rangeEnd"
      ${includeQuality ? ', quality_report AS "quality"' : ""}
    FROM upload_batches
    ORDER BY uploaded_at DESC
    LIMIT 20`,
  );
  return rows as UploadRow[];
}

export async function getDashboard(uploadId?: string): Promise<DashboardPayload | null> {
  await ensureSchema();
  const sql = database();
  const uploads = await listUploadRows(false);
  if (!uploads.length) return null;

  const activeId = uploadId && uploads.some((upload) => upload.id === uploadId) ? uploadId : uploads[0].id;
  const activeRows = await sql.query(
    `SELECT id::text,
      file_name AS "fileName",
      uploaded_at::text AS "uploadedAt",
      accepted_rows AS "acceptedRows",
      rejected_rows AS "rejectedRows",
      range_start::text AS "rangeStart",
      range_end::text AS "rangeEnd",
      quality_report AS "quality"
    FROM upload_batches WHERE id = $1::uuid`,
    [activeId],
  );
  const activeUpload = activeRows[0] as UploadSummary & { quality: QualityReport };

  const serviceRows = (await sql.query(
    `WITH grouped AS (
      SELECT service_id, max(service_name) AS service_name,
        count(*)::int AS checks,
        count(*) FILTER (WHERE is_available)::int AS successful_checks,
        count(*) FILTER (WHERE NOT is_available)::int AS failed_checks,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms IS NOT NULL) AS p95_latency_ms,
        floor(extract(epoch FROM (max(checked_at) - min(checked_at))) / 900)::int + 1 AS expected_checks
      FROM service_checks WHERE upload_id = $1::uuid
      GROUP BY service_id
    )
    SELECT service_id AS "serviceId", service_name AS "serviceName", checks,
      successful_checks AS "successfulChecks", failed_checks AS "failedChecks",
      round((100.0 * successful_checks / nullif(checks, 0))::numeric, 4)::float8 AS availability,
      p95_latency_ms AS "p95LatencyMs", expected_checks AS "expectedChecks",
      round((100.0 * checks / nullif(expected_checks, 0))::numeric, 2)::float8 AS coverage
    FROM grouped ORDER BY availability ASC, service_name ASC`,
    [activeId],
  )) as ServiceSummary[];

  const summaryRows = await sql.query(
    `WITH service_ranges AS (
      SELECT service_id, count(*) AS checks,
        floor(extract(epoch FROM (max(checked_at) - min(checked_at))) / 900) + 1 AS expected
      FROM service_checks WHERE upload_id = $1::uuid GROUP BY service_id
    )
    SELECT count(*)::int AS checks,
      count(*) FILTER (WHERE is_available)::int AS "successfulChecks",
      count(*) FILTER (WHERE NOT is_available)::int AS "failedChecks",
      round((100.0 * count(*) FILTER (WHERE is_available) / nullif(count(*), 0))::numeric, 4)::float8 AS availability,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE latency_ms IS NOT NULL) AS "p95LatencyMs",
      count(*) FILTER (WHERE latency_ms IS NULL)::int AS "missingLatency",
      (SELECT round((100.0 * sum(checks) / nullif(sum(expected), 0))::numeric, 2)::float8 FROM service_ranges) AS coverage
    FROM service_checks WHERE upload_id = $1::uuid`,
    [activeId],
  );
  const rawSummary = summaryRows[0];

  const daily = (await sql.query(
    `SELECT to_char(checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
      round((100.0 * count(*) FILTER (WHERE is_available) / nullif(count(*), 0))::numeric, 4)::float8 AS availability,
      count(*) FILTER (WHERE NOT is_available)::int AS "failedChecks"
    FROM service_checks WHERE upload_id = $1::uuid
    GROUP BY 1 ORDER BY 1`,
    [activeId],
  )) as DailyPoint[];

  return {
    activeUpload,
    uploads,
    summary: {
      checks: asNumber(rawSummary.checks),
      successfulChecks: asNumber(rawSummary.successfulChecks),
      failedChecks: asNumber(rawSummary.failedChecks),
      availability: asNumber(rawSummary.availability),
      p95LatencyMs:
        rawSummary.p95LatencyMs === null ? null : asNumber(rawSummary.p95LatencyMs),
      missingLatency: asNumber(rawSummary.missingLatency),
      servicesAtRisk: serviceRows.filter((service) => asNumber(service.availability) < 99.9).length,
      coverage: asNumber(rawSummary.coverage, 100),
    },
    services: serviceRows.map((service) => ({
      ...service,
      checks: asNumber(service.checks),
      successfulChecks: asNumber(service.successfulChecks),
      failedChecks: asNumber(service.failedChecks),
      availability: asNumber(service.availability),
      p95LatencyMs: service.p95LatencyMs === null ? null : asNumber(service.p95LatencyMs),
      expectedChecks: asNumber(service.expectedChecks),
      coverage: asNumber(service.coverage),
    })),
    daily,
  };
}

export type LogFilters = {
  uploadId?: string;
  from?: string;
  to?: string;
  service?: string;
  state?: "up" | "down";
  page?: number;
};

function nextUtcDay(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString();
}

export async function getLogs(filters: LogFilters): Promise<LogsPayload> {
  await ensureSchema();
  const sql = database();
  const uploads = await listUploadRows();
  if (!uploads.length) return { rows: [], total: 0, page: 1, pageSize: 50, pageCount: 0 };
  const uploadId =
    filters.uploadId && uploads.some((upload) => upload.id === filters.uploadId)
      ? filters.uploadId
      : uploads[0].id;
  const values: unknown[] = [uploadId];
  const conditions = ["upload_id = $1::uuid"];

  if (filters.from) {
    values.push(`${filters.from}T00:00:00.000Z`);
    conditions.push(`checked_at >= $${values.length}::timestamptz`);
  }
  if (filters.to) {
    values.push(nextUtcDay(filters.to));
    conditions.push(`checked_at < $${values.length}::timestamptz`);
  } else if (filters.from) {
    values.push(nextUtcDay(filters.from));
    conditions.push(`checked_at < $${values.length}::timestamptz`);
  }
  if (filters.service) {
    values.push(filters.service);
    conditions.push(`service_id = $${values.length}`);
  }
  if (filters.state) {
    values.push(filters.state === "up");
    conditions.push(`is_available = $${values.length}`);
  }

  const where = conditions.join(" AND ");
  const countRows = await sql.query(`SELECT count(*)::int AS total FROM service_checks WHERE ${where}`, values);
  const total = asNumber(countRows[0]?.total);
  const pageSize = 50;
  const pageCount = Math.ceil(total / pageSize);
  const page = Math.min(Math.max(filters.page ?? 1, 1), Math.max(pageCount, 1));
  values.push(pageSize, (page - 1) * pageSize);

  const rows = (await sql.query(
    `SELECT id::text, checked_at::text AS "checkedAt", service_id AS "serviceId",
      service_name AS "serviceName", status_code AS "statusCode",
      latency_ms AS "latencyMs", agent, region, is_available AS "isAvailable", warnings
    FROM service_checks WHERE ${where}
    ORDER BY checked_at DESC, service_id ASC
    LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )) as LogRecord[];

  return {
    rows: rows.map((row) => ({
      ...row,
      statusCode: asNumber(row.statusCode),
      latencyMs: row.latencyMs === null ? null : asNumber(row.latencyMs),
    })),
    total,
    page,
    pageSize,
    pageCount,
  };
}
