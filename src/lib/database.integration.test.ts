import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { cleanCsv } from "./cleaner";

const HEADER = "service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region";
const databases: PGlite[] = [];

async function testDatabase() {
  const database = new PGlite();
  databases.push(database);
  const schemaPath = fileURLToPath(new URL("../../db/schema.sql", import.meta.url));
  await database.exec(await readFile(schemaPath, "utf8"));
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("Postgres persistence contract", () => {
  it("persists one cleaned dataset and supports SLA aggregation and date filtering", async () => {
    const database = await testDatabase();
    const uploadId = "d17c84c2-eec0-4cb9-9966-10034e60f186";
    const cleaned = cleanCsv([
      HEADER,
      "svc-auth,auth-api,2025-05-01T00:00:00Z,200,0.1,s,agent-1,ap-south-1",
      "svc-auth,auth-api,1746057600,503,900,ms,agent-2,ap-south-1",
      "svc-auth,auth-api,2025-05-01T00:15:00Z,200,,ms,agent-1,ap-south-1",
      "svc-search,search-api,2025-05-02T00:00:00Z,999,300,ms,agent-1,ap-south-1",
    ].join("\n"));

    expect(cleaned.records).toHaveLength(3);
    await database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO upload_batches (
          id, file_name, total_rows, accepted_rows, rejected_rows,
          duplicate_rows, range_start, range_end, quality_report
        ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::jsonb)`,
        [uploadId, "fixture.csv", cleaned.report.totalRows, cleaned.report.acceptedRows,
          cleaned.report.rejectedRows, cleaned.report.duplicateRows, cleaned.rangeStart,
          cleaned.rangeEnd, JSON.stringify(cleaned.report)],
      );
      await transaction.query(
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
        [uploadId, JSON.stringify(cleaned.records.map((record) => ({
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
        })))],
      );
    });

    const aggregate = await database.query<{
      checks: number;
      successes: number;
      failures: number;
      availability: number;
      p95: number;
      missing_latency: number;
    }>(
      `SELECT count(*)::int AS checks,
        count(*) FILTER (WHERE is_available)::int AS successes,
        count(*) FILTER (WHERE NOT is_available)::int AS failures,
        round((100.0 * count(*) FILTER (WHERE is_available) / count(*))::numeric, 4)::float8 AS availability,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms IS NOT NULL) AS p95,
        count(*) FILTER (WHERE latency_ms IS NULL)::int AS missing_latency
      FROM service_checks WHERE upload_id = $1::uuid`,
      [uploadId],
    );
    expect(aggregate.rows[0]).toMatchObject({
      checks: 3,
      successes: 1,
      failures: 2,
      availability: 33.3333,
      p95: 870,
      missing_latency: 1,
    });

    const singleDay = await database.query<{ service_id: string; status_code: number }>(
      `SELECT service_id, status_code FROM service_checks
       WHERE upload_id = $1::uuid
         AND checked_at >= $2::timestamptz
         AND checked_at < $3::timestamptz
       ORDER BY checked_at DESC`,
      [uploadId, "2025-05-01T00:00:00.000Z", "2025-05-02T00:00:00.000Z"],
    );
    expect(singleDay.rows).toEqual([
      { service_id: "svc-auth", status_code: 200 },
      { service_id: "svc-auth", status_code: 503 },
    ]);

    const batch = await database.query<{ quality_report: { duplicateRows: number } }>(
      "SELECT quality_report FROM upload_batches WHERE id = $1::uuid",
      [uploadId],
    );
    expect(batch.rows[0].quality_report.duplicateRows).toBe(1);
  });

  it("enforces one service observation per normalized interval", async () => {
    const database = await testDatabase();
    const uploadId = "dd16cf83-317d-4ea1-9204-1ee0e2b00334";
    await database.query(
      `INSERT INTO upload_batches (
        id, file_name, total_rows, accepted_rows, rejected_rows,
        duplicate_rows, quality_report
      ) VALUES ($1::uuid, 'fixture.csv', 1, 1, 0, 0, '{}'::jsonb)`,
      [uploadId],
    );
    const values = [uploadId, "svc-auth", "auth-api", "2025-05-01T00:00:00Z", 200, 100, "agent-1", "ap-south-1", true, 2];
    const insert = `INSERT INTO service_checks (
      upload_id, service_id, service_name, checked_at, status_code,
      latency_ms, agent, region, is_available, source_row
    ) VALUES ($1::uuid, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10)`;
    await database.query(insert, values);
    await expect(database.query(insert, values)).rejects.toThrow(/unique/i);
  });
});
