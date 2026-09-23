import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanCsv } from "../src/lib/cleaner";

const directory = resolve(process.argv[2] ?? "sample-data");
const files = (await readdir(directory)).filter((file) => file.toLowerCase().endsWith(".csv")).sort();

for (const file of files) {
  const result = cleanCsv(await readFile(resolve(directory, file), "utf8"));
  const services = new Set(result.records.map((record) => record.serviceId));
  const failures = result.records.filter((record) => !record.isAvailable).length;
  console.log(JSON.stringify({
    file,
    inputRows: result.report.totalRows,
    cleanedRows: result.report.acceptedRows,
    rejectedRows: result.report.rejectedRows,
    duplicateRows: result.report.duplicateRows,
    conflictingDuplicates: result.report.conflictingDuplicates,
    unixTimestamps: result.report.normalizedTimestamps,
    secondsConverted: result.report.convertedLatencies,
    missingLatency: result.report.missingLatencies,
    statusSentinels: result.report.nonStandardStatuses,
    rejectionReasons: result.report.rejectionReasons,
    failures,
    services: services.size,
    rangeStart: result.rangeStart,
    rangeEnd: result.rangeEnd,
  }));
}
