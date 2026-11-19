import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { zipSync } from "fflate";
import { THEMES, DEFAULT_THEME_ID } from "./engine/themes.js";
import { contrast, hexToRgb } from "./engine/color.js";
import { ConvertClient, RenderClient, type ConvertResult } from "./lib/workers";
import type { ThemeColors } from "./lib/protocol";
import { Compare } from "./components/Compare";
import { DropZone } from "./components/DropZone";
import { Icon } from "./components/Icon";

type Status = "queued" | "converting" | "done" | "error" | "password";
interface Job {
  id: string;
  file: File;
  status: Status;
  progress?: { page: number; total: number; stage: string };
  result?: ConvertResult;
  resultThemeKey?: string;
  error?: string;
  password?: string;
}

const REPO_URL = "https://github.com/MSSakib03/dark-pdf-converter";
const MAX_BYTES = 300 * 1024 * 1024;
const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const isDocx = (f: File) => /\.docx$/i.test(f.name);
const outName = (f: File, kind: "pdf" | "docx") => f.name.replace(/\.(pdf|docx)$/i, "") + `-dark.${kind}`;

function download(data: ArrayBuffer | Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [themeId, setThemeId] = useState<string>(() => { try { return localStorage.getItem("themeId") ?? DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; } });
  const [custom, setCustom] = useState<ThemeColors>({ bg: "#1B1D22", text: "#E6E6E6" });
  const [imageMode, setImageMode] = useState<"smart" | "keep">("smart");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const convert = useRef<ConvertClient>(null as unknown as ConvertClient);
  const render = useRef<RenderClient | null>(null);
  if (!convert.current) convert.current = new ConvertClient();
  const cancelRequested = useRef(false);

  useEffect(() => { try { localStorage.setItem("themeId", themeId); } catch { /* storage unavailable */ } }, [themeId]);

  const theme: ThemeColors = useMemo(() => {
    if (themeId === "custom") return custom;
    const t = THEMES.find((x) => x.id === themeId) ?? THEMES[0];
    return { bg: t.bg, text: t.text };
  }, [themeId, custom]);
  const themeKey = `${theme.bg}|${theme.text}|${imageMode}`;

  const update = (id: string, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const addFiles = useCallback((files: File[]) => {
    const accepted: Job[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (!/\.(pdf|docx)$/i.test(f.name)) { rejected.push(`${f.name}: only PDF and DOCX files are supported.`); continue; }
      if (f.size > MAX_BYTES) { rejected.push(`${f.name}: larger than ${fmtSize(MAX_BYTES)}.`); continue; }
      accepted.push({ id: crypto.randomUUID(), file: f, status: "queued" });
    }
    setNotice(rejected.length ? rejected.join(" ") : null);
    if (accepted.length) {
      convert.current.warmUp();
      setJobs((js) => [...js, ...accepted]);
      setSelected((s) => s ?? accepted[0].id);
    }
  }, []);

  const runQueue = async () => {
    setBusy(true);
    cancelRequested.current = false;
    // snapshot of jobs that need (re)conversion with the current settings
    const todo = jobs.filter((j) => j.status === "queued" || j.status === "error" || (j.status === "done" && j.resultThemeKey !== themeKey));
    for (const j of todo) {
      if (cancelRequested.current) break;
      update(j.id, { status: "converting", progress: { page: 0, total: 0, stage: "Loading" }, error: undefined });
      try {
        const bytes = await j.file.arrayBuffer();
        const result = await convert.current.convert(j.id, j.file.name, bytes, theme, { imageMode, password: j.password }, (p) => update(j.id, { progress: p }));
        update(j.id, { status: "done", result, resultThemeKey: themeKey, progress: undefined });
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === "password-required" || err.code === "password-wrong") update(j.id, { status: "password", error: err.message, progress: undefined });
        else if (err.code === "cancelled") update(j.id, { status: "queued", progress: undefined });
        else update(j.id, { status: "error", error: err.message, progress: undefined });
      }
    }
    setBusy(false);
  };

  const cancel = () => { cancelRequested.current = true; convert.current.cancel(); };
  const remove = (id: string) => {
    setJobs((js) => js.filter((j) => j.id !== id));
    setSelected((s) => (s === id ? null : s));
  };
  const downloadAll = () => {
    const done = jobs.filter((j) => j.result);
    const files: Record<string, Uint8Array> = {};
    for (const j of done) files[outName(j.file, j.result!.kind)] = new Uint8Array(j.result!.output);
    download(zipSync(files, { level: 0 }), "dark-documents.zip", "application/zip");
  };

  const pendingCount = jobs.filter((j) => j.status === "queued" || j.status === "error" || (j.status === "done" && j.resultThemeKey !== themeKey)).length;
  const doneCount = jobs.filter((j) => j.result).length;
  const selectedJob = jobs.find((j) => j.id === selected) ?? null;
  if (!render.current && typeof Worker !== "undefined") render.current = new RenderClient();
  const ratio = contrast(hexToRgb(theme.text), hexToRgb(theme.bg));

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b border-white/5 bg-[#111214]/90 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-7xl px-4 h-14 flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-8" />
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold leading-tight">Dark PDF Converter</h1>
            <p className="text-xs text-zinc-400 leading-tight truncate">PDF · Scanned PDF · DOCX → Dark Mode</p>
          </div>
          <span className="ml-auto hidden sm:inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 text-emerald-300 text-xs px-2.5 py-1">
            <Icon name="lock" className="size-3.5" /> Files never leave your device
          </span>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="ml-auto sm:ml-2 p-2 rounded-lg hover:bg-white/5 text-zinc-300" aria-label="Source code on GitHub">
            <Icon name="github" className="size-5" />
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-5 grid gap-5 lg:grid-cols-[400px_minmax(0,1fr)] flex-1">
        <section className="flex flex-col gap-5 min-w-0">
          <DropZone onFiles={addFiles} compact={jobs.length > 0} />
          {notice && <p role="alert" className="text-sm text-amber-300 bg-amber-500/10 rounded-lg px-3 py-2">{notice}</p>}

          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="section-title">Theme</h2>
              <span className={`text-xs ${ratio >= 7 ? "text-emerald-300" : ratio >= 4.5 ? "text-zinc-400" : "text-amber-300"}`} title="Text contrast (WCAG)">
                Contrast {ratio.toFixed(1)}:1
              </span>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-2" role="radiogroup" aria-label="Dark theme">
              {THEMES.map((t) => (
                <button key={t.id} role="radio" aria-checked={themeId === t.id} title={t.note ?? t.name} onClick={() => setThemeId(t.id)}
                  className={`swatch ${themeId === t.id ? "ring-2 ring-amber-300" : "ring-1 ring-white/10 hover:ring-white/30"}`} style={{ background: t.bg }}>
                  <span className="text-[13px] font-semibold" style={{ color: t.text }}>Aa</span>
                  <span className="absolute bottom-1 left-1.5 right-1.5 h-1 rounded-full" style={{ background: t.link }} />
                </button>
              ))}
              <button role="radio" aria-checked={themeId === "custom"} onClick={() => setThemeId("custom")} title="Custom colours"
                className={`swatch ${themeId === "custom" ? "ring-2 ring-amber-300" : "ring-1 ring-white/10 hover:ring-white/30"}`} style={{ background: custom.bg }}>
                <Icon name="palette" className="size-4" style={{ color: custom.text }} />
              </button>
            </div>
            <p className="mt-2 text-sm text-zinc-300">{themeId === "custom" ? "Custom" : THEMES.find((t) => t.id === themeId)?.name}
              <span className="text-zinc-500">{themeId !== "custom" && THEMES.find((t) => t.id === themeId)?.note ? ` — ${THEMES.find((t) => t.id === themeId)?.note}` : ""}</span>
            </p>
            {themeId === "custom" && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="field">Background<input type="color" value={custom.bg} onChange={(e) => setCustom({ ...custom, bg: e.target.value.toUpperCase() })} /></label>
                <label className="field">Text<input type="color" value={custom.text} onChange={(e) => setCustom({ ...custom, text: e.target.value.toUpperCase() })} /></label>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="section-title mb-3">Images</h2>
            <div className="seg" role="radiogroup" aria-label="Image handling">
              <button role="radio" aria-checked={imageMode === "smart"} onClick={() => setImageMode("smart")} className={imageMode === "smart" ? "on" : ""}>Smart</button>
              <button role="radio" aria-checked={imageMode === "keep"} onClick={() => setImageMode("keep")} className={imageMode === "keep" ? "on" : ""}>Keep original</button>
            </div>
            <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
              {imageMode === "smart" ? "Diagrams and white backgrounds inside images turn dark; photos stay as they are." : "Images are left untouched (like Microsoft Word)."}
            </p>
          </div>

          {jobs.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <h2 className="section-title">Files</h2>
                <span className="text-xs text-zinc-500">{jobs.length}</span>
                {doneCount > 1 && <button onClick={downloadAll} className="ml-auto btn-ghost text-xs"><Icon name="download" className="size-3.5" /> All (ZIP)</button>}
              </div>
              <ul className="flex flex-col gap-2">
                {jobs.map((j) => (
                  <FileRow key={j.id} job={j} active={j.id === selected} outdated={j.status === "done" && j.resultThemeKey !== themeKey}
                    onSelect={() => setSelected(j.id)} onRemove={() => remove(j.id)}
                    onPassword={(pw) => update(j.id, { password: pw, status: "queued", error: undefined })} />
                ))}
              </ul>
              <div className="mt-4 flex gap-2">
                {busy ? (
                  <button onClick={cancel} className="btn-secondary flex-1"><Icon name="x" className="size-4" /> Cancel</button>
                ) : (
                  <button onClick={runQueue} disabled={pendingCount === 0} className="btn-primary flex-1">
                    <Icon name="moon" className="size-4" /> {pendingCount === 0 ? "All converted" : `Convert ${pendingCount === 1 ? "" : pendingCount + " files"}`.trim()}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="min-w-0">
          <Preview job={selectedJob} renderer={render.current} />
        </section>
      </main>

      <footer className="border-t border-white/5 text-xs text-zinc-500">
        <div className="mx-auto max-w-7xl px-4 py-4 flex flex-col sm:flex-row gap-2 sm:items-center">
          <p>Everything runs locally in your browser with WebAssembly. No uploads, no tracking.</p>
          <p className="sm:ml-auto">Free & open source (AGPL-3.0) · <a className="underline hover:text-zinc-300" href={REPO_URL} target="_blank" rel="noreferrer">Source code</a></p>
        </div>
      </footer>
    </div>
  );
}

function FileRow({ job, active, outdated, onSelect, onRemove, onPassword }: {
  job: Job; active: boolean; outdated: boolean; onSelect: () => void; onRemove: () => void; onPassword: (pw: string) => void;
}) {
  const [pw, setPw] = useState("");
  const p = job.progress;
  const pct = p && p.total ? Math.round(((p.page - 1) / p.total) * 100) : 0;
  return (
    <li className={`rounded-xl px-3 py-2.5 ${active ? "bg-white/[0.06] ring-1 ring-white/10" : "bg-white/[0.02] hover:bg-white/[0.04]"}`}>
      <div className="flex items-center gap-3">
        <button onClick={onSelect} className="flex items-center gap-3 min-w-0 flex-1 text-left" aria-label={`Preview ${job.file.name}`}>
          <span className={`shrink-0 grid place-items-center size-9 rounded-lg text-[10px] font-bold ${isDocx(job.file) ? "bg-sky-500/15 text-sky-300" : "bg-rose-500/15 text-rose-300"}`}>
            {isDocx(job.file) ? "DOCX" : "PDF"}
          </span>
          <span className="min-w-0">
            <span className="block text-sm truncate">{job.file.name}</span>
            <span className="block text-xs text-zinc-500">
              {fmtSize(job.file.size)}
              {job.status === "done" && job.result && <> · {job.result.report.pages ? `${job.result.report.pages} pages · ` : ""}{(job.result.report.ms / 1000).toFixed(1)}s{outdated ? " · settings changed" : ""}</>}
              {job.status === "queued" && " · ready"}
              {job.status === "converting" && p && ` · ${p.stage}${p.total ? ` ${p.page}/${p.total}` : ""}`}
            </span>
          </span>
        </button>
        {job.status === "done" && job.result && (
          <button onClick={() => download(job.result!.output, outName(job.file, job.result!.kind), job.result!.kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
            className="btn-icon text-amber-300" aria-label="Download"><Icon name="download" className="size-4.5" /></button>
        )}
        {job.status !== "converting" && <button onClick={onRemove} className="btn-icon text-zinc-500" aria-label="Remove"><Icon name="x" className="size-4" /></button>}
      </div>
      {job.status === "converting" && (
        <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-amber-300 transition-all duration-300" style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
      )}
      {job.status === "error" && <p className="mt-2 text-xs text-rose-300">{job.error}</p>}
      {job.result?.report.warnings?.map((w) => <p key={w} className="mt-2 text-xs text-amber-300">{w}</p>)}
      {job.status === "password" && (
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (pw) onPassword(pw); }}>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="PDF password" className="input flex-1" autoComplete="off" />
          <button className="btn-secondary text-xs">Unlock</button>
          <span className="sr-only">{job.error}</span>
        </form>
      )}
      {job.status === "password" && <p className="mt-1 text-xs text-amber-300">{job.error}</p>}
    </li>
  );
}

function Preview({ job, renderer }: { job: Job | null; renderer: RenderClient | null }) {
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(0);
  const [imgs, setImgs] = useState<{ a?: string; b?: string; ratio?: number }>({});
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const keyA = job ? job.id + ":orig" : "";
  const keyB = job?.result ? job.id + ":dark:" + job.resultThemeKey : "";

  useEffect(() => { setPage(0); }, [job?.id]);

  // open documents in the preview worker
  useEffect(() => {
    let alive = true;
    setErr(null);
    setImgs({});
    if (!job || !renderer || isDocx(job.file) || job.status === "password") return;
    (async () => {
      try {
        const { pageCount } = await renderer.open(keyA, await job.file.arrayBuffer(), job.password);
        if (alive) setCount(pageCount);
        if (job.result && job.result.kind === "pdf") await renderer.open(keyB, job.result.output);
        if (alive) setImgs({}); // trigger render
      } catch (e) { if (alive) setErr("This file cannot be previewed."); }
    })();
    return () => { alive = false; };
  }, [job?.id, keyB, job?.status, renderer]);

  // render current page
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    if (!job || !renderer || isDocx(job.file) || !count) return;
    const width = Math.min(1800, Math.round((box.current?.clientWidth ?? 800) * Math.min(2, window.devicePixelRatio || 1)));
    (async () => {
      try {
        const a = await renderer.render(keyA, page, width);
        const ua = URL.createObjectURL(new Blob([a.png], { type: "image/png" })); urls.push(ua);
        let ub: string | undefined;
        if (keyB) { const b = await renderer.render(keyB, page, width); ub = URL.createObjectURL(new Blob([b.png], { type: "image/png" })); urls.push(ub); }
        if (alive) setImgs({ a: ua, b: ub, ratio: a.height / a.width });
      } catch { /* document not ready yet */ }
    })();
    return () => { alive = false; setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000); };
  }, [job?.id, keyB, page, count, renderer]);

  if (!job) {
    return (
      <div className="card h-full min-h-[320px] grid place-items-center text-center">
        <div className="max-w-sm">
          <Icon name="moon" className="size-10 mx-auto text-amber-300/80" />
          <h2 className="mt-3 text-lg font-semibold">Read documents comfortably at night</h2>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            Add a PDF or Word file. Text stays selectable, links keep working, photos keep their colours,
            and scanned pages get a clean dark background.
          </p>
        </div>
      </div>
    );
  }
  if (isDocx(job.file)) {
    return (
      <div className="card text-sm text-zinc-300 leading-relaxed">
        <h2 className="section-title mb-2">Word document</h2>
        <p>DOCX files are converted to a <b>dark DOCX</b>: colours change, the layout stays exactly as in Word. Open the result in Microsoft Word, LibreOffice or Google Docs.</p>
        <p className="mt-2 text-zinc-400">Want a dark PDF? In Word choose <i>File → Save as → PDF</i>, then add that PDF here.</p>
        {job.result && <p className="mt-3 text-emerald-300">Done — use the download button next to the file.</p>}
      </div>
    );
  }
  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <h2 className="section-title truncate">{job.result ? "Before / After" : "Original"}</h2>
        {count > 0 && (
          <div className="ml-auto flex items-center gap-1">
            <button className="btn-icon" disabled={page <= 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><Icon name="chevron-left" className="size-4" /></button>
            <span className="text-xs text-zinc-400 tabular-nums w-16 text-center">{page + 1} / {count}</span>
            <button className="btn-icon" disabled={page >= count - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><Icon name="chevron-right" className="size-4" /></button>
          </div>
        )}
      </div>
      <div ref={box} className="bg-[#0b0c0e] p-3 sm:p-5">
        {err && <p className="text-sm text-rose-300">{err}</p>}
        {!err && imgs.a && (imgs.b ? <Compare before={imgs.a} after={imgs.b} ratio={imgs.ratio ?? 1.4} /> : <img src={imgs.a} alt={`Page ${page + 1}`} className="mx-auto max-w-full rounded shadow-2xl" />)}
        {!err && !imgs.a && <div className="aspect-[3/4] max-h-[70vh] mx-auto rounded bg-white/[0.03] animate-pulse" />}
        {!job.result && imgs.a && <p className="mt-3 text-center text-xs text-zinc-500">Press <b>Convert</b> to see the dark version.</p>}
      </div>
    </div>
  );
}
