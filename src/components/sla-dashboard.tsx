"use client";

import {
  Activity, AlertTriangle, ArrowUpRight, CalendarDays, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronsUpDown, CloudUpload, Database, Eye,
  FileCheck2, Gauge, LoaderCircle, RefreshCw, ServerCog, ShieldCheck, Timer, X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis,
} from "recharts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DashboardPayload, LogRecord, LogsPayload } from "@/lib/types";

type ApiEnvelope<T> = { data: T; error?: string };
type Filters = { from: string; to: string; service: string; state: string };

const EMPTY_FILTERS: Filters = { from: "", to: "", service: "", state: "" };
const availabilityChart = {
  availability: { label: "Availability", color: "var(--chart-1)" },
  failedChecks: { label: "Failed checks", color: "var(--chart-4)" },
} satisfies ChartConfig;
const latencyChart = {
  p95LatencyMs: { label: "P95 latency (ms)", color: "var(--chart-3)" },
} satisfies ChartConfig;

const QUALITY_EXPLANATIONS: Record<string, { title: string; detail: string; impact: string }> = {
  duplicate_consolidated: {
    title: "Duplicate interval consolidated",
    detail: "More than one agent reported this service at the same normalized 15-minute timestamp.",
    impact: "It counts once. The failed observation wins; otherwise the slower reading wins, so deduplication cannot improve the SLA.",
  },
  missing_latency: {
    title: "Latency was missing",
    detail: "The source row had no latency value, but its timestamp, service identity, status, agent and region were usable.",
    impact: "The check remains in availability calculations and is excluded from latency percentiles.",
  },
  non_standard_status: {
    title: "Non-standard status retained",
    detail: "The status is an agent sentinel rather than a valid HTTP status in the 100–599 range.",
    impact: "It is preserved for auditability and classified unavailable instead of being silently dropped.",
  },
};

const percent = (value: number) => `${value.toFixed(value >= 99 ? 3 : 2)}%`;
const latency = (value: number | null) => value === null ? "N/A" : value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${Math.round(value)} ms`;
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)) : "—";
const timestamp = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

async function readApi<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok) throw new Error(body.error ?? "The request failed.");
  return body.data;
}

function Metric({ label, value, note, icon: Icon, tone = "green" }: {
  label: string; value: string; note: string; icon: typeof Gauge; tone?: "green" | "amber" | "blue" | "red";
}) {
  const tones = {
    green: "bg-emerald-950 text-lime-300",
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-sky-100 text-sky-800",
    red: "bg-rose-100 text-rose-800",
  };
  return (
    <div className="border-border/80 flex min-w-0 items-start gap-4 border-r px-5 py-5 last:border-r-0 max-lg:border-b max-lg:nth-[2n]:border-r-0 max-sm:border-r-0">
      <div className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-md ${tones[tone]}`}><Icon className="size-4" /></div>
      <div className="min-w-0">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.14em] uppercase">{label}</p>
        <p className="mt-1 font-mono text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="text-muted-foreground mt-1 truncate text-xs">{note}</p>
      </div>
    </div>
  );
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
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [selectedCheck, setSelectedCheck] = useState<LogRecord | null>(null);
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
      if (response.status === 503) { setDatabaseReady(false); setDashboard(null); return; }
      const data = await readApi<DashboardPayload | null>(response);
      setDatabaseReady(true); setDashboard(data);
      if (data) setActiveUploadId(data.activeUpload.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dashboard data could not be loaded.");
    } finally { setIsLoading(false); }
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

  useEffect(() => { const task = window.setTimeout(() => void loadDashboard(), 0); return () => window.clearTimeout(task); }, [loadDashboard]);
  useEffect(() => { const task = window.setTimeout(() => void loadLogs(), 0); return () => window.clearTimeout(task); }, [loadLogs]);

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
    setError(""); setLogsLoading(true); setPage(1); setFilters(draftFilters);
  }
  function clearFilters() { setDraftFilters(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setLogsLoading(true); setPage(1); }

  const quality = dashboard?.activeUpload.quality;
  const services = dashboard?.services ?? [];
  const currentUpload = dashboard?.uploads.find((upload) => upload.id === activeUploadId) ?? dashboard?.activeUpload;
  const chartFloor = Math.max(0, Math.min(...(dashboard?.daily.map((day) => day.availability) ?? [99.5])) - 0.08);

  return (
    <main className="min-h-screen">
      <header className="bg-background/90 sticky top-0 z-40 border-b backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-8">
          <a href="#top" className="flex items-center gap-3">
            <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-sm"><Activity className="size-4" /></span>
            <span><span className="block text-sm font-bold tracking-tight">EarthRe</span><span className="text-muted-foreground block text-[9px] font-semibold tracking-[0.2em] uppercase">SLA intelligence</span></span>
          </a>
          <div className="text-muted-foreground flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] uppercase">
            <span className={`size-1.5 rounded-full ${databaseReady === false ? "bg-amber-500" : "bg-emerald-600"}`} />
            {databaseReady === false ? "Storage offline" : "UTC workspace"}
          </div>
        </div>
      </header>

      <div id="top" className="mx-auto max-w-[1440px] px-4 py-10 sm:px-8 lg:py-14">
        <section className="grid items-end gap-10 lg:grid-cols-[1fr_420px] lg:gap-20">
          <div className="max-w-3xl">
            <div className="mb-6 flex items-center gap-3"><Separator className="bg-primary h-px! w-10!" /><span className="text-primary text-[10px] font-bold tracking-[0.2em] uppercase">Reliability record / 15-minute cadence</span></div>
            <h1 className="max-w-2xl text-4xl leading-[1.02] font-semibold tracking-[-0.045em] text-balance sm:text-6xl lg:text-7xl">Evidence for every minute of uptime.</h1>
            <p className="text-muted-foreground mt-6 max-w-xl text-sm leading-6 sm:text-base">Clean multi-agent health checks, surface incident windows, and produce an SLA number that engineering and billing can both defend.</p>
          </div>

          <Card className="bg-primary text-primary-foreground gap-4 rounded-lg border-0 py-5 shadow-[0_24px_60px_-28px_rgba(8,55,41,.65)]">
            <CardHeader className="px-5">
              <div className="flex items-start justify-between"><div><CardTitle className="text-sm">Ingest checks</CardTitle><CardDescription className="text-primary-foreground/55 mt-1 text-xs">CSV · maximum 4 MB</CardDescription></div><CloudUpload className="text-lime-300 size-5" /></div>
            </CardHeader>
            <CardContent className="px-5">
              <form onSubmit={handleUpload} className="space-y-3">
                <button type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) setSelectedFile(file); }} className={`flex w-full items-center gap-3 rounded-md border border-dashed px-4 py-4 text-left transition ${dragging ? "border-lime-300 bg-white/10" : "border-white/20 bg-white/[.04] hover:bg-white/[.07]"}`}>
                  <FileCheck2 className="text-lime-300 size-5 shrink-0" /><span className="min-w-0"><span className="block truncate text-xs font-semibold">{selectedFile?.name ?? "Drop a CSV or browse"}</span><span className="text-primary-foreground/50 mt-1 block text-[10px]">{selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB ready to process` : "Required columns are checked server-side"}</span></span>
                </button>
                <input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
                <Button className="h-9 w-full bg-lime-300 text-emerald-950 hover:bg-lime-200" disabled={!selectedFile || uploading || databaseReady === false}>{uploading ? <><LoaderCircle className="animate-spin" /> Processing…</> : <><CloudUpload /> Upload &amp; process</>}</Button>
              </form>
            </CardContent>
          </Card>
        </section>

        <div className="mt-8 space-y-3">
          {error && <Alert variant="destructive" className="bg-card"><AlertTriangle /><AlertTitle>Request failed</AlertTitle><AlertDescription>{error}</AlertDescription><AlertAction><Button variant="ghost" size="icon-xs" onClick={() => setError("")}><X /></Button></AlertAction></Alert>}
          {notice && <Alert className="border-emerald-700/25 bg-emerald-50 text-emerald-950"><Check /><AlertTitle>Dataset ready</AlertTitle><AlertDescription>{notice}</AlertDescription><AlertAction><Button variant="ghost" size="icon-xs" onClick={() => setNotice("")}><X /></Button></AlertAction></Alert>}
        </div>

        {databaseReady === false && <Card className="mt-8 rounded-lg border-amber-700/25 bg-amber-50"><CardContent className="flex flex-col items-start gap-5 py-6 sm:flex-row sm:items-center"><span className="grid size-11 place-items-center rounded-md bg-amber-100 text-amber-800"><Database className="size-5" /></span><div className="flex-1"><p className="text-[10px] font-bold tracking-[0.16em] text-amber-800 uppercase">One-time setup</p><h2 className="mt-1 text-lg font-semibold">Connect the Postgres store</h2><p className="text-muted-foreground mt-1 text-sm">Attach Neon in Vercel or set <code className="bg-black/5 px-1 py-0.5 font-mono text-xs">DATABASE_URL</code> locally. The schema creates itself on first use.</p></div><Button variant="outline" onClick={() => { setIsLoading(true); void loadDashboard(); }}><RefreshCw /> Retry</Button></CardContent></Card>}
        {isLoading && databaseReady !== false && <div className="text-muted-foreground mt-12 flex h-52 items-center justify-center gap-3 text-sm"><LoaderCircle className="size-5 animate-spin" /> Loading monitoring record…</div>}
        {!isLoading && databaseReady && !dashboard && <Card className="mt-8 rounded-lg border-dashed bg-card/75"><CardContent className="flex flex-col items-center py-16 text-center"><ServerCog className="text-primary size-7" /><h2 className="mt-4 font-semibold">No monitoring dataset yet</h2><p className="text-muted-foreground mt-1 text-sm">Upload one of the supplied CSV files to create the first durable SLA record.</p></CardContent></Card>}

        {dashboard && <div className="mt-10 space-y-5">
          <Card className="rounded-lg py-0"><CardContent className="flex flex-col gap-5 px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="w-full space-y-2 lg:max-w-xl"><label className="text-muted-foreground block text-[10px] font-bold tracking-[0.14em] uppercase">Active dataset</label><Popover open={datasetOpen} onOpenChange={setDatasetOpen}><PopoverTrigger render={<Button variant="outline" role="combobox" aria-expanded={datasetOpen} className="h-auto w-full justify-between bg-background px-3 py-2.5 text-left" />}><span className="min-w-0"><span className="block truncate text-xs font-semibold">{currentUpload?.fileName}</span><span className="text-muted-foreground mt-0.5 block text-[10px] font-normal">Uploaded {shortDate(currentUpload?.uploadedAt ?? null)} · {currentUpload?.acceptedRows.toLocaleString()} clean checks</span></span><ChevronsUpDown className="text-muted-foreground ml-3 size-4 shrink-0" /></PopoverTrigger><PopoverContent align="start" className="w-[min(440px,calc(100vw-2rem))] p-0"><Command><CommandInput placeholder="Find a dataset…" /><CommandList><CommandEmpty>No dataset found.</CommandEmpty><CommandGroup heading={`${dashboard.uploads.length} uploaded dataset${dashboard.uploads.length === 1 ? "" : "s"}`}>{dashboard.uploads.map((upload) => <CommandItem key={upload.id} value={`${upload.fileName} ${upload.uploadedAt}`} data-checked={upload.id === activeUploadId} className="items-start py-2.5" onSelect={() => { setDatasetOpen(false); if (upload.id === activeUploadId) return; setPage(1); setIsLoading(true); setLogsLoading(true); setActiveUploadId(upload.id); void loadDashboard(upload.id); }}><Database className="mt-0.5 size-4 text-primary" /><span className="min-w-0 pr-4"><span className="block truncate text-xs font-semibold">{upload.fileName}</span><span className="text-muted-foreground mt-1 block text-[10px]">{shortDate(upload.rangeStart)} — {shortDate(upload.rangeEnd)} · {upload.acceptedRows.toLocaleString()} checks</span></span></CommandItem>)}</CommandGroup></CommandList></Command></PopoverContent></Popover></div>
            <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-2 text-xs"><span className="flex items-center gap-2"><CalendarDays className="size-3.5" />{shortDate(dashboard.activeUpload.rangeStart)} — {shortDate(dashboard.activeUpload.rangeEnd)}</span><span className="flex items-center gap-2"><ShieldCheck className="size-3.5" />{dashboard.activeUpload.acceptedRows.toLocaleString()} cleaned checks</span></div>
          </CardContent></Card>

          <Collapsible open={statsOpen} onOpenChange={setStatsOpen}>
            <Card className="gap-0 overflow-hidden rounded-lg py-0">
              <CollapsibleTrigger className="hover:bg-muted/40 flex w-full items-center justify-between px-5 py-4 text-left transition">
                <span className="flex items-center gap-4"><span className="text-primary font-mono text-xs font-bold">01</span><span><span className="block text-sm font-semibold">SLA command view</span><span className="text-muted-foreground mt-0.5 block text-xs">Availability, latency, service risk and source integrity</span></span></span>
                <span className="text-muted-foreground flex items-center gap-2 text-[10px] font-semibold tracking-wider uppercase">{statsOpen ? "Collapse" : "Expand"}<ChevronDown className={`size-4 transition ${statsOpen ? "rotate-180" : ""}`} /></span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Separator />
                <div className="grid sm:grid-cols-2 lg:grid-cols-4">
                  <Metric icon={Gauge} label="Observed availability" value={percent(dashboard.summary.availability)} note={dashboard.summary.availability >= 99.9 ? "99.9% threshold met" : `${dashboard.summary.servicesAtRisk} service${dashboard.summary.servicesAtRisk === 1 ? "" : "s"} below target`} tone={dashboard.summary.availability >= 99.9 ? "green" : "red"} />
                  <Metric icon={AlertTriangle} label="Failed checks" value={dashboard.summary.failedChecks.toLocaleString()} note={`${dashboard.summary.checks.toLocaleString()} observed intervals`} tone="amber" />
                  <Metric icon={Timer} label="P95 latency" value={latency(dashboard.summary.p95LatencyMs)} note={`${dashboard.summary.missingLatency} readings unavailable`} tone="blue" />
                  <Metric icon={Activity} label="Data coverage" value={`${dashboard.summary.coverage.toFixed(2)}%`} note="Against the 15-minute cadence" />
                </div>
                <Separator />

                <div className="grid gap-4 p-4 xl:grid-cols-[1.65fr_1fr]">
                  <Card className="rounded-md bg-background/55 shadow-none"><CardHeader><div className="flex items-start justify-between gap-4"><div><CardTitle className="text-sm">Availability timeline</CardTitle><CardDescription>Daily availability with the contractual threshold</CardDescription></div><Badge variant="outline" className="font-mono text-[10px]">Target 99.900%</Badge></div></CardHeader><CardContent>
                    <ChartContainer config={availabilityChart} className="h-[250px] w-full aspect-auto">
                      <AreaChart accessibilityLayer data={dashboard.daily} margin={{ left: 0, right: 10, top: 8, bottom: 0 }}>
                        <defs><linearGradient id="availabilityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-availability)" stopOpacity={0.28} /><stop offset="95%" stopColor="var(--color-availability)" stopOpacity={0.02} /></linearGradient></defs>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={10} minTickGap={28} tickFormatter={(value) => String(value).slice(5)} />
                        <YAxis domain={[chartFloor, 100]} tickLine={false} axisLine={false} width={48} tickFormatter={(value) => `${Number(value).toFixed(2)}%`} />
                        <ReferenceLine y={99.9} stroke="var(--chart-3)" strokeDasharray="5 4" />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                        <Area dataKey="availability" type="monotone" fill="url(#availabilityFill)" stroke="var(--color-availability)" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ChartContainer>
                  </CardContent></Card>

                  <Card className="rounded-md bg-background/55 shadow-none"><CardHeader><CardTitle className="text-sm">Latency by service</CardTitle><CardDescription>P95 after unit normalization</CardDescription></CardHeader><CardContent>
                    <ChartContainer config={latencyChart} className="h-[250px] w-full aspect-auto">
                      <BarChart accessibilityLayer data={services} layout="vertical" margin={{ left: 2, right: 18 }}>
                        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(value) => `${value}ms`} />
                        <YAxis dataKey="serviceName" type="category" tickLine={false} axisLine={false} width={82} tickFormatter={(value) => String(value).replace("-api", "").replace("-worker", "")} />
                        <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent hideLabel />} />
                        <Bar dataKey="p95LatencyMs" fill="var(--color-p95LatencyMs)" radius={[0, 3, 3, 0]} barSize={16} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent></Card>
                </div>

                <div className="grid gap-px border-y bg-border sm:grid-cols-2 lg:grid-cols-4">
                  {[ [quality?.normalizedTimestamps, "timestamps normalized"], [quality?.convertedLatencies, "seconds converted to ms"], [quality?.duplicateRows, "duplicates consolidated"], [quality?.nonStandardStatuses, "status sentinels retained"] ].map(([value, label]) => <div key={String(label)} className="bg-card px-5 py-4"><span className="font-mono text-lg font-semibold tabular-nums">{Number(value ?? 0).toLocaleString()}</span><span className="text-muted-foreground ml-2 text-[10px] tracking-wide uppercase">{label}</span></div>)}
                </div>

                <div className="p-4"><div className="mb-4 flex items-end justify-between"><div><p className="text-sm font-semibold">Service ledger</p><p className="text-muted-foreground mt-1 text-xs">Each service measured independently against 99.9%</p></div><span className="text-muted-foreground hidden text-[10px] tracking-wider uppercase sm:block">Worst availability first</span></div><div className="grid gap-3 lg:grid-cols-2">{services.map((service) => <div key={service.serviceId} className="bg-background/55 rounded-md border p-4"><div className="mb-3 flex items-start justify-between gap-4"><div className="flex min-w-0 items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${service.availability >= 99.9 ? "bg-emerald-600" : "bg-rose-600"}`} /><div className="min-w-0"><p className="truncate text-sm font-semibold">{service.serviceName}</p><p className="text-muted-foreground font-mono text-[10px]">{service.serviceId}</p></div></div><div className="text-right"><p className={`font-mono text-sm font-bold tabular-nums ${service.availability < 99.9 ? "text-rose-700" : "text-emerald-800"}`}>{percent(service.availability)}</p><p className="text-muted-foreground text-[10px]">{service.failedChecks} failed · {latency(service.p95LatencyMs)} p95</p></div></div><Progress value={service.availability} className="[&_[data-slot=progress-indicator]]:bg-emerald-700 [&_[data-slot=progress-track]]:h-1.5" /></div>)}</div></div>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          <Card className="gap-0 overflow-hidden rounded-lg py-0">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-4"><div className="flex items-center gap-4"><span className="text-primary font-mono text-xs font-bold">02</span><div><CardTitle className="text-sm">Underlying checks</CardTitle><CardDescription>Cleaned records · newest first · UTC</CardDescription></div></div><Badge variant="outline" className="font-mono text-[10px]">{logs?.total.toLocaleString() ?? "—"} records</Badge></CardHeader>
            <Separator />
            <CardContent className="bg-muted/20 px-5 py-4">
              <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.15fr_1fr_auto_auto] lg:items-end" onSubmit={applyFilters}>
                <label className="space-y-1.5"><span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Start date</span><Input type="date" value={draftFilters.from} onChange={(event) => setDraftFilters({ ...draftFilters, from: event.target.value })} /></label>
                <label className="space-y-1.5"><span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">End date <i className="font-normal normal-case">optional</i></span><Input type="date" min={draftFilters.from || undefined} value={draftFilters.to} onChange={(event) => setDraftFilters({ ...draftFilters, to: event.target.value })} /></label>
                <label className="space-y-1.5"><span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Service</span><Select value={draftFilters.service || "__all"} onValueChange={(value) => setDraftFilters({ ...draftFilters, service: value === "__all" ? "" : String(value) })}><SelectTrigger className="w-full bg-background"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all">All services</SelectItem>{services.map((service) => <SelectItem value={service.serviceId} key={service.serviceId}>{service.serviceName}</SelectItem>)}</SelectContent></Select></label>
                <label className="space-y-1.5"><span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">State</span><Select value={draftFilters.state || "__all"} onValueChange={(value) => setDraftFilters({ ...draftFilters, state: value === "__all" ? "" : String(value) })}><SelectTrigger className="w-full bg-background"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all">Any state</SelectItem><SelectItem value="up">Available</SelectItem><SelectItem value="down">Unavailable</SelectItem></SelectContent></Select></label>
                <Button type="submit">Apply</Button>
                {Object.values(filters).some(Boolean) ? <Button type="button" variant="ghost" onClick={clearFilters}><X /> Clear</Button> : <span />}
              </form>
              <p className="text-muted-foreground mt-2 text-[10px]">Start date alone selects one UTC day; add an end date for an inclusive range.</p>
            </CardContent>
            <Separator />
            <div className="relative overflow-x-auto">
              {logsLoading && <div className="bg-card/75 absolute inset-0 z-10 grid place-items-center backdrop-blur-[1px]"><LoaderCircle className="text-primary size-5 animate-spin" /></div>}
              <Table className="min-w-[980px]"><TableHeader><TableRow className="bg-muted/20"><TableHead>Timestamp (UTC)</TableHead><TableHead>Service</TableHead><TableHead>State</TableHead><TableHead>Status</TableHead><TableHead>Latency</TableHead><TableHead>Reporter</TableHead><TableHead className="text-right">Quality</TableHead></TableRow></TableHeader><TableBody>
                {logs?.rows.map((row) => <TableRow key={row.id} className="group"><TableCell className="font-mono text-[11px] tabular-nums">{timestamp(row.checkedAt)}</TableCell><TableCell><span className="block text-xs font-semibold">{row.serviceName}</span><span className="text-muted-foreground font-mono text-[10px]">{row.serviceId}</span></TableCell><TableCell><Badge variant="outline" className={row.isAvailable ? "border-emerald-700/20 bg-emerald-50 text-emerald-800" : "border-rose-700/20 bg-rose-50 text-rose-800"}><span className={`size-1.5 rounded-full ${row.isAvailable ? "bg-emerald-600" : "bg-rose-600"}`} />{row.isAvailable ? "Available" : "Down"}</Badge></TableCell><TableCell className="font-mono text-xs">HTTP {row.statusCode}</TableCell><TableCell className="font-mono text-xs">{row.latencyMs === null ? <span className="text-muted-foreground">N/A</span> : latency(row.latencyMs)}</TableCell><TableCell><span className="block text-xs font-medium">{row.agent}</span><span className="text-muted-foreground text-[10px]">{row.region}</span></TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" className={row.warnings.length ? "border border-amber-700/20 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:text-amber-900" : "text-muted-foreground hover:text-foreground"} onClick={() => setSelectedCheck(row)} aria-label={`View quality details for ${row.serviceName} at ${timestamp(row.checkedAt)}`}>{row.warnings.length ? <><AlertTriangle />{row.warnings.length} flag{row.warnings.length === 1 ? "" : "s"}</> : <><Check />Clean</>}<Eye className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100" /></Button></TableCell></TableRow>)}
                {logs && !logs.rows.length && <TableRow><TableCell colSpan={7} className="text-muted-foreground h-32 text-center">No checks match these filters.</TableCell></TableRow>}
              </TableBody></Table>
            </div>
            {logs && logs.pageCount > 1 && <><Separator /><div className="flex items-center justify-between px-5 py-3"><span className="text-muted-foreground font-mono text-[10px]">PAGE {logs.page} / {logs.pageCount}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={logs.page <= 1} onClick={() => { setLogsLoading(true); setPage((current) => current - 1); }}><ChevronLeft /> Previous</Button><Button variant="outline" size="sm" disabled={logs.page >= logs.pageCount} onClick={() => { setLogsLoading(true); setPage((current) => current + 1); }}>Next <ChevronRight /></Button></div></div></>}
          </Card>
        </div>}
      </div>

      <Dialog open={selectedCheck !== null} onOpenChange={(open) => { if (!open) setSelectedCheck(null); }}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
          {selectedCheck && <>
            <DialogHeader className="pr-8">
              <div className="mb-1 flex items-center gap-2">
                <Badge variant="outline" className={selectedCheck.warnings.length ? "border-amber-700/20 bg-amber-50 text-amber-800" : "border-emerald-700/20 bg-emerald-50 text-emerald-800"}>{selectedCheck.warnings.length ? <><AlertTriangle />Quality issue</> : <><Check />Quality clean</>}</Badge>
                <Badge variant="outline" className={selectedCheck.isAvailable ? "text-emerald-800" : "text-rose-800"}>{selectedCheck.isAvailable ? "Service available" : "Service unavailable"}</Badge>
              </div>
              <DialogTitle>Why this record is {selectedCheck.warnings.length ? "flagged" : "clean"}</DialogTitle>
              <DialogDescription>Data-quality status is separate from service health. A valid HTTP 500 record can be clean data while still representing downtime.</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3">
              {[
                ["Service", selectedCheck.serviceName],
                ["Timestamp", timestamp(selectedCheck.checkedAt)],
                ["HTTP status", String(selectedCheck.statusCode)],
                ["Latency", latency(selectedCheck.latencyMs)],
                ["Agent", selectedCheck.agent],
                ["Region", selectedCheck.region],
              ].map(([label, value]) => <div key={label} className="bg-card p-3"><p className="text-muted-foreground text-[9px] font-semibold tracking-wider uppercase">{label}</p><p className="mt-1 break-words font-mono text-[11px] font-medium">{value}</p></div>)}
            </div>

            {selectedCheck.warnings.length ? <div className="space-y-3">
              <p className="text-[10px] font-bold tracking-[0.14em] uppercase">Detected quality conditions</p>
              {selectedCheck.warnings.map((warning) => {
                const explanation = QUALITY_EXPLANATIONS[warning] ?? { title: warning.replaceAll("_", " "), detail: "The processing pipeline attached this quality marker to the cleaned record.", impact: "The marker remains stored with the check for auditability." };
                return <div key={warning} className="rounded-md border border-amber-700/20 bg-amber-50/70 p-4"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" /><div><p className="text-xs font-semibold text-amber-950">{explanation.title}</p><p className="mt-1 text-xs leading-5 text-amber-950/70">{explanation.detail}</p><p className="mt-2 text-[10px] font-medium leading-4 text-amber-900"><span className="font-bold uppercase">SLA handling:</span> {explanation.impact}</p></div></div></div>;
              })}
            </div> : <div className="rounded-md border border-emerald-700/20 bg-emerald-50/70 p-4">
              <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-700" /><div><p className="text-xs font-semibold text-emerald-950">All ingestion checks passed</p><p className="mt-1 text-xs leading-5 text-emerald-950/70">The record has valid service and reporter identity, an explicit UTC timestamp, a supported latency unit with a non-negative value, and no duplicate service interval.</p></div></div>
              <Separator className="my-3 bg-emerald-800/10" />
              <ul className="grid gap-2 text-[11px] text-emerald-950/75 sm:grid-cols-2">
                {["Identity fields present", "Timestamp valid in UTC", "Status parsed successfully", "Latency normalized to ms", "Reporter and region present", "Unique service interval"].map((item) => <li key={item} className="flex items-center gap-2"><Check className="size-3 text-emerald-700" />{item}</li>)}
              </ul>
            </div>}

            <div className="bg-muted/45 rounded-md p-3 text-[11px] leading-5"><span className="font-semibold">Availability result:</span> This check is counted as <span className={selectedCheck.isAvailable ? "font-semibold text-emerald-800" : "font-semibold text-rose-800"}>{selectedCheck.isAvailable ? "available" : "unavailable"}</span> because HTTP {selectedCheck.statusCode} {selectedCheck.isAvailable ? "is within the accepted 2xx–3xx range" : "falls outside the accepted 2xx–3xx range"}.</div>
            <DialogFooter showCloseButton />
          </>}
        </DialogContent>
      </Dialog>

      <footer className="border-t bg-card/65"><div className="text-muted-foreground mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-6 text-[9px] font-semibold tracking-[0.12em] uppercase sm:flex-row sm:items-center sm:justify-between sm:px-8"><span>EarthRe reliability record</span><span className="flex items-center gap-1.5">Observed checks · cleaned data · UTC <ArrowUpRight className="size-3" /></span></div></footer>
    </main>
  );
}
