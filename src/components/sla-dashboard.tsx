"use client";

import {
  Activity, AlertTriangle, BarChart3, CalendarDays, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleGauge, CloudUpload, Database,
  FileCheck2, LoaderCircle, RefreshCw, ServerCog, ShieldCheck, Timer, X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { DashboardPayload, LogsPayload } from "@/lib/types";

type ApiEnvelope<T> = { data: T; error?: string };
type Filters = { from: string; to: string; service: string; state: string };
const EMPTY_FILTERS: Filters = { from: "", to: "", service: "", state: "" };

const percent = (value: number) => `${value.toFixed(value >= 99 ? 3 : 2)}%`;
const latency = (value: number | null) => value === null ? "N/A" : value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${Math.round(value)} ms`;
const date = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "—";
const timestamp = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

async function readApi<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok) throw new Error(body.error ?? "The request failed.");
  return body.data;
}

export function SlaDashboard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [logs, setLogs] = useState<LogsPayload | null>(null);
  const [activeUploadId, setActiveUploadId] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [statsOpen, setStatsOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [databaseReady, setDatabaseReady] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadDashboard = useCallback(async (uploadId?: string) => {
    try {
      const query = uploadId ? `?uploadId=${encodeURIComponent(uploadId)}` : "";
      const response = await fetch(`/api/dashboard${query}`, { cache: "no-store" });
      if (response.status === 503) {
        setDatabaseReady(false);
        setDashboard(null);
        return;
      }
      const data = await readApi<DashboardPayload | null>(response);
      setDatabaseReady(true);
      setDashboard(data);
      if (data) setActiveUploadId(data.activeUpload.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dashboard data could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    if (!activeUploadId) return;
    const params = new URLSearchParams({ uploadId: activeUploadId, page: String(page) });
    Object.entries(filters).forEach(([key, value]) => value && params.set(key, value));
    try {
      const response = await fetch(`/api/logs?${params}`, { cache: "no-store" });
      setLogs(await readApi<LogsPayload>(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Monitoring logs could not be loaded.");
    } finally { setLogsLoading(false); }
  }, [activeUploadId, filters, page]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadDashboard(), 0);
    return () => window.clearTimeout(task);
  }, [loadDashboard]);
  useEffect(() => {
    const task = window.setTimeout(() => void loadLogs(), 0);
    return () => window.clearTimeout(task);
  }, [loadLogs]);

  async function handleUpload(event: FormEvent) {
    event.preventDefault();
    if (!selectedFile) return;
    setUploading(true); setError(""); setNotice("");
    const body = new FormData(); body.append("file", selectedFile);
    try {
      const response = await fetch("/api/uploads", { method: "POST", body });
      const payload = (await response.json()) as { uploadId?: string; error?: string; report?: { acceptedRows: number; rejectedRows: number; duplicateRows: number } };
      if (!response.ok || !payload.uploadId) throw new Error(payload.error ?? "Upload failed.");
      setNotice(`${payload.report?.acceptedRows.toLocaleString() ?? 0} checks saved · ${payload.report?.duplicateRows.toLocaleString() ?? 0} duplicates consolidated · ${payload.report?.rejectedRows.toLocaleString() ?? 0} rejected`);
      setSelectedFile(null); if (inputRef.current) inputRef.current.value = "";
      setFilters(EMPTY_FILTERS); setDraftFilters(EMPTY_FILTERS); setPage(1);
      await loadDashboard(payload.uploadId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Upload failed."); }
    finally { setUploading(false); }
  }

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    if (draftFilters.from && draftFilters.to && draftFilters.from > draftFilters.to) { setError("The start date must not be after the end date."); return; }
    setError(""); setPage(1); setFilters(draftFilters);
  }
  function clearFilters() { setDraftFilters(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setPage(1); }

  const quality = dashboard?.activeUpload.quality;
  const services = dashboard?.services ?? [];

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="EarthRe SLA Monitor home"><span className="brand-mark"><Activity size={20} /></span><span><b>EarthRe</b><small>SLA monitor</small></span></a>
        <div className={`system-state ${databaseReady === false ? "offline" : ""}`}><span className="pulse" />{databaseReady === false ? "Database setup needed" : "Monitoring workspace"}</div>
      </header>

      <div className="content" id="top">
        <section className="hero">
          <div><p className="eyebrow">Reliability operations / UTC</p><h1>Know what happened.<br /><em>Defend every number.</em></h1><p className="hero-copy">Turn raw multi-agent health checks into an auditable availability record for on-call and billing teams.</p></div>
          <form className={`upload-card ${dragging ? "is-dragging" : ""}`} onSubmit={handleUpload}>
            <div className="upload-heading"><div className="icon-box"><CloudUpload size={20} /></div><div><strong>Ingest monitoring checks</strong><span>CSV · up to 4 MB</span></div></div>
            <button className="drop-zone" type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) setSelectedFile(file); }}>
              <FileCheck2 size={22} />{selectedFile ? <><b>{selectedFile.name}</b><span>{(selectedFile.size / 1024).toFixed(1)} KB ready</span></> : <><b>Drop a CSV here</b><span>or choose a file</span></>}
            </button>
            <input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
            <button className="primary-button" disabled={!selectedFile || uploading || databaseReady === false}>{uploading ? <><LoaderCircle className="spin" size={17} /> Processing in cloud…</> : <><CloudUpload size={17} /> Upload &amp; process</>}</button>
          </form>
        </section>

        {error && <div className="message error-message"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
        {notice && <div className="message success-message"><Check size={18} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss message"><X size={16} /></button></div>}
        {databaseReady === false && <section className="setup-panel"><div className="setup-icon"><Database size={27} /></div><div><p className="eyebrow">One-time setup</p><h2>Connect the Postgres store</h2><p>Add a Neon database in the Vercel Marketplace, or set <code>DATABASE_URL</code> locally. Tables are created automatically on the first request.</p></div><button className="secondary-button" onClick={() => void loadDashboard()}><RefreshCw size={16} /> Retry connection</button></section>}
        {isLoading && databaseReady !== false && <div className="loading-panel"><LoaderCircle className="spin" size={24} /><span>Loading monitoring workspace…</span></div>}
        {!isLoading && databaseReady && !dashboard && <section className="empty-panel"><ServerCog size={32} /><h2>No monitoring dataset yet</h2><p>Upload one of the supplied CSV files to create the first durable SLA record.</p></section>}

        {dashboard && <>
          <section className="dataset-bar"><div><span className="label">Active dataset</span><select value={activeUploadId} onChange={(event) => { setPage(1); setActiveUploadId(event.target.value); void loadDashboard(event.target.value); }}>{dashboard.uploads.map((upload) => <option key={upload.id} value={upload.id}>{upload.fileName} · {date(upload.uploadedAt)}</option>)}</select></div><div className="dataset-meta"><span><CalendarDays size={15} /> {date(dashboard.activeUpload.rangeStart)} — {date(dashboard.activeUpload.rangeEnd)}</span><span><ShieldCheck size={15} /> {dashboard.activeUpload.acceptedRows.toLocaleString()} clean checks</span></div></section>

          <section className={`stats-panel ${statsOpen ? "" : "collapsed"}`}>
            <button className="section-heading" onClick={() => setStatsOpen((open) => !open)} aria-expanded={statsOpen}><span><span className="section-number">01</span><span><b>SLA command view</b><small>Availability, risk and source integrity</small></span></span><span className="collapse-control">{statsOpen ? "Collapse" : "Expand"}<ChevronDown size={18} /></span></button>
            {statsOpen && <div className="stats-content">
              <div className="kpi-grid">
                <article className="kpi-card"><div className="kpi-icon"><CircleGauge size={20} /></div><span>Observed availability</span><strong>{percent(dashboard.summary.availability)}</strong><small className={dashboard.summary.availability >= 99.9 ? "positive" : "negative"}>{dashboard.summary.availability >= 99.9 ? "SLA threshold met" : `${dashboard.summary.servicesAtRisk} service${dashboard.summary.servicesAtRisk === 1 ? "" : "s"} below 99.9%`}</small></article>
                <article className="kpi-card"><div className="kpi-icon amber"><AlertTriangle size={20} /></div><span>Failed checks</span><strong>{dashboard.summary.failedChecks.toLocaleString()}</strong><small>{dashboard.summary.checks.toLocaleString()} observed intervals</small></article>
                <article className="kpi-card"><div className="kpi-icon blue"><Timer size={20} /></div><span>P95 latency</span><strong>{latency(dashboard.summary.p95LatencyMs)}</strong><small>{dashboard.summary.missingLatency} readings unavailable</small></article>
                <article className="kpi-card"><div className="kpi-icon violet"><BarChart3 size={20} /></div><span>Data coverage</span><strong>{dashboard.summary.coverage.toFixed(2)}%</strong><small>Against 15-minute cadence</small></article>
              </div>
              <div className="analysis-grid">
                <article className="service-panel"><div className="panel-title"><div><span className="label">Service ledger</span><h3>Availability by service</h3></div><span className="threshold-key"><i /> 99.9% target</span></div><div className="service-list">{services.map((service) => <div className="service-row" key={service.serviceId}><div className="service-name"><span className={service.availability >= 99.9 ? "health-dot" : "health-dot risk"} /><span><b>{service.serviceName}</b><small>{service.serviceId}</small></span></div><div className="availability-track"><span style={{ width: `${Math.max(2, service.availability)}%` }} /></div><b className={service.availability >= 99.9 ? "" : "risk-text"}>{percent(service.availability)}</b><span className="service-failures">{service.failedChecks} failed</span><span className="service-latency">{latency(service.p95LatencyMs)} p95</span></div>)}</div></article>
                <article className="trend-panel"><div className="panel-title"><div><span className="label">Daily signal</span><h3>Availability pulse</h3></div></div><div className="daily-chart" aria-label="Daily availability chart">{dashboard.daily.map((day) => { const severity = Math.min(100, Math.max(8, (100 - day.availability) * 30 + 8)); return <span key={day.date} className={day.failedChecks ? "has-failures" : ""} style={{ height: `${severity}%` }} title={`${day.date}: ${percent(day.availability)}, ${day.failedChecks} failed`} />; })}</div><div className="chart-axis"><span>{dashboard.daily.at(0)?.date}</span><span>{dashboard.daily.at(-1)?.date}</span></div><div className="quality-box"><span className="label">Cleaning receipt</span><div className="quality-grid"><div><b>{quality?.normalizedTimestamps.toLocaleString()}</b><span>timestamps normalized</span></div><div><b>{quality?.convertedLatencies.toLocaleString()}</b><span>second values converted</span></div><div><b>{quality?.duplicateRows.toLocaleString()}</b><span>duplicates consolidated</span></div><div><b>{quality?.nonStandardStatuses.toLocaleString()}</b><span>sentinels flagged as down</span></div></div></div></article>
              </div>
            </div>}
          </section>

          <section className="logs-panel">
            <div className="section-heading static-heading"><span><span className="section-number">02</span><span><b>Underlying checks</b><small>Cleaned records · newest first · UTC</small></span></span><span className="row-count">{logs?.total.toLocaleString() ?? "—"} records</span></div>
            <form className="filters" onSubmit={applyFilters}><label><span>Start date</span><input type="date" value={draftFilters.from} onChange={(event) => setDraftFilters({ ...draftFilters, from: event.target.value })} /></label><label><span>End date <i>optional</i></span><input type="date" min={draftFilters.from || undefined} value={draftFilters.to} onChange={(event) => setDraftFilters({ ...draftFilters, to: event.target.value })} /></label><label><span>Service</span><select value={draftFilters.service} onChange={(event) => setDraftFilters({ ...draftFilters, service: event.target.value })}><option value="">All services</option>{services.map((service) => <option value={service.serviceId} key={service.serviceId}>{service.serviceName}</option>)}</select></label><label><span>State</span><select value={draftFilters.state} onChange={(event) => setDraftFilters({ ...draftFilters, state: event.target.value })}><option value="">Any state</option><option value="up">Available</option><option value="down">Unavailable</option></select></label><button className="filter-button" type="submit">Apply filters</button>{Object.values(filters).some(Boolean) && <button className="clear-button" type="button" onClick={clearFilters}><X size={15} /> Clear</button>}</form>
            <p className="filter-hint">A start date on its own selects that single UTC day. Add an end date for a range.</p>
            <div className="table-wrap">{logsLoading && <div className="table-loader"><LoaderCircle className="spin" size={23} /></div>}<table><thead><tr><th>Timestamp (UTC)</th><th>Service</th><th>State</th><th>Status</th><th>Latency</th><th>Reporter</th><th>Quality</th></tr></thead><tbody>{logs?.rows.map((row) => <tr key={row.id}><td className="mono">{timestamp(row.checkedAt)}</td><td><b>{row.serviceName}</b><small>{row.serviceId}</small></td><td><span className={`status-badge ${row.isAvailable ? "up" : "down"}`}><i />{row.isAvailable ? "Available" : "Down"}</span></td><td className="mono">HTTP {row.statusCode}</td><td>{row.latencyMs === null ? <span className="muted">N/A</span> : latency(row.latencyMs)}</td><td><b>{row.agent}</b><small>{row.region}</small></td><td>{row.warnings.length ? <span className="warning-chip" title={row.warnings.join(", ")}><AlertTriangle size={13} /> {row.warnings.length}</span> : <span className="clean-chip"><Check size={13} /> Clean</span>}</td></tr>)}{logs && !logs.rows.length && <tr><td colSpan={7} className="no-rows">No checks match these filters.</td></tr>}</tbody></table></div>
            {logs && logs.pageCount > 1 && <div className="pagination"><span>Page {logs.page} of {logs.pageCount}</span><div><button disabled={logs.page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={17} /> Previous</button><button disabled={logs.page >= logs.pageCount} onClick={() => setPage((current) => current + 1)}>Next <ChevronRight size={17} /></button></div></div>}
          </section>
        </>}
      </div>
      <footer><span>EarthRe reliability desk</span><span>All SLA calculations use cleaned observed checks · Times shown in UTC</span></footer>
    </main>
  );
}
