export type QualityReport = {
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  conflictingDuplicates: number;
  normalizedTimestamps: number;
  convertedLatencies: number;
  missingLatencies: number;
  nonStandardStatuses: number;
  rejectionReasons: Record<string, number>;
  sampleErrors: Array<{ row: number; reason: string }>;
};

export type CleanCheck = {
  serviceId: string;
  serviceName: string;
  checkedAt: string;
  statusCode: number;
  latencyMs: number | null;
  agent: string;
  region: string;
  isAvailable: boolean;
  sourceRow: number;
  warnings: string[];
};

export type CleanResult = {
  records: CleanCheck[];
  report: QualityReport;
  rangeStart: string | null;
  rangeEnd: string | null;
};

export type UploadSummary = {
  id: string;
  fileName: string;
  uploadedAt: string;
  acceptedRows: number;
  rejectedRows: number;
  rangeStart: string | null;
  rangeEnd: string | null;
};

export type ServiceSummary = {
  serviceId: string;
  serviceName: string;
  checks: number;
  successfulChecks: number;
  failedChecks: number;
  availability: number;
  p95LatencyMs: number | null;
  expectedChecks: number;
  coverage: number;
};

export type DailyPoint = {
  date: string;
  availability: number;
  failedChecks: number;
};

export type DashboardPayload = {
  activeUpload: UploadSummary & { quality: QualityReport };
  uploads: UploadSummary[];
  summary: {
    checks: number;
    successfulChecks: number;
    failedChecks: number;
    availability: number;
    p95LatencyMs: number | null;
    missingLatency: number;
    servicesAtRisk: number;
    coverage: number;
  };
  services: ServiceSummary[];
  daily: DailyPoint[];
};

export type LogRecord = {
  id: string;
  checkedAt: string;
  serviceId: string;
  serviceName: string;
  statusCode: number;
  latencyMs: number | null;
  agent: string;
  region: string;
  isAvailable: boolean;
  warnings: string[];
};

export type LogsPayload = {
  rows: LogRecord[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};
