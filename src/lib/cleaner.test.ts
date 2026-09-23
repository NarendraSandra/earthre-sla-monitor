import { describe, expect, it } from "vitest";
import { cleanCsv } from "@/lib/cleaner";

const HEADER = "service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region";

describe("cleanCsv", () => {
  it("normalizes Unix timestamps and seconds to UTC milliseconds", () => {
    const result = cleanCsv(`${HEADER}\nsvc-a,api,1746938700,200,0.717,s,agent-1,ap-south-1`);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      checkedAt: new Date(1_746_938_700_000).toISOString(),
      latencyMs: 717,
      isAvailable: true,
    });
    expect(result.report.normalizedTimestamps).toBe(1);
    expect(result.report.convertedLatencies).toBe(1);
  });

  it("retains a non-standard status as a flagged failure", () => {
    const result = cleanCsv(`${HEADER}\nsvc-a,api,2025-05-01T00:00:00Z,999,10,ms,agent-1,ap-south-1`);
    expect(result.records[0].isAvailable).toBe(false);
    expect(result.records[0].warnings).toContain("non_standard_status");
    expect(result.report.nonStandardStatuses).toBe(1);
  });

  it("consolidates duplicates conservatively", () => {
    const result = cleanCsv([
      HEADER,
      "svc-a,api,2025-05-01T00:00:00Z,200,100,ms,agent-1,ap-south-1",
      "svc-a,api,1746057600,503,900,ms,agent-2,ap-south-1",
    ].join("\n"));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ statusCode: 503, isAvailable: false, latencyMs: 900 });
    expect(result.records[0].agent).toBe("agent-1 + agent-2");
    expect(result.records[0].warnings).toContain("duplicate_consolidated");
    expect(result.report.duplicateRows).toBe(1);
    expect(result.report.conflictingDuplicates).toBe(1);
  });

  it("keeps missing latency as null without dropping the availability observation", () => {
    const result = cleanCsv(`${HEADER}\nsvc-a,api,2025-05-01T00:00:00Z,200,,ms,agent-1,ap-south-1`);
    expect(result.records[0].latencyMs).toBeNull();
    expect(result.records[0].warnings).toContain("missing_latency");
    expect(result.report.missingLatencies).toBe(1);
  });

  it("rejects timezone-less timestamps and malformed latency", () => {
    const result = cleanCsv([
      HEADER,
      "svc-a,api,2025-05-01 00:00:00,200,100,ms,agent-1,ap-south-1",
      "svc-a,api,2025-05-01T00:15:00Z,200,fast,ms,agent-1,ap-south-1",
    ].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.report.rejectedRows).toBe(2);
    expect(result.report.rejectionReasons).toEqual({
      "Invalid or timezone-less timestamp": 1,
      "Invalid latency": 1,
    });
  });

  it("requires the documented CSV shape", () => {
    expect(() => cleanCsv("service_id,timestamp\nsvc-a,2025-05-01T00:00:00Z")).toThrow(
      /Missing required columns/,
    );
  });
});
