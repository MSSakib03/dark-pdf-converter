// Main-thread clients for the conversion and preview workers.
import type { ToConvertWorker, FromConvertWorker, ToRenderWorker, FromRenderWorker, ThemeColors, ConvertOptions, ConversionReport } from "./protocol";

export interface ConvertResult { kind: "pdf" | "docx"; output: ArrayBuffer; report: ConversionReport }
type Progress = { page: number; total: number; stage: string };

/** One conversion at a time; cancel() terminates the worker (the only way to stop WASM mid-page). */
export class ConvertClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending: { jobId: string; resolve: (r: ConvertResult) => void; reject: (e: Error & { code?: string }) => void; onProgress: (p: Progress) => void } | null = null;

  /** Messages posted while the worker is still loading the WASM module can be lost: wait for "ready". */
  private ensure(): Promise<Worker> {
    if (this.worker && this.ready) return this.ready.then(() => this.worker!);
    const w = new Worker(new URL("../worker/convert.worker.ts", import.meta.url), { type: "module" });
    let markReady!: () => void;
    this.ready = new Promise<void>((r) => (markReady = r));
    w.onmessage = (ev: MessageEvent<FromConvertWorker>) => {
      const m = ev.data;
      if (m.type === "ready") { markReady(); return; }
      if (!this.pending || m.jobId !== this.pending.jobId) return;
      if (m.type === "progress") this.pending.onProgress(m);
      else if (m.type === "done") { const p = this.pending; this.pending = null; p.resolve({ kind: m.kind, output: m.output, report: m.report }); }
      else if (m.type === "error") { const p = this.pending; this.pending = null; p.reject(Object.assign(new Error(m.message), { code: m.code })); }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      const p = this.pending; this.pending = null;
      this.worker?.terminate(); this.worker = null; this.ready = null;
      p?.reject(Object.assign(new Error("The converter stopped unexpectedly (the file may be too large for this device's memory)."), { code: "crash" }));
    };
    this.worker = w;
    return this.ready.then(() => w);
  }

  /** Start loading the engine early (e.g. when the first file is added). */
  warmUp() { void this.ensure(); }

  convert(jobId: string, name: string, bytes: ArrayBuffer, theme: ThemeColors, options: ConvertOptions, onProgress: (p: Progress) => void) {
    return new Promise<ConvertResult>((resolve, reject) => {
      this.pending = { jobId, resolve, reject, onProgress };
      const msg: ToConvertWorker = { type: "convert", jobId, name, bytes, theme, options };
      this.ensure().then((w) => w.postMessage(msg));
    });
  }

  cancel() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    const p = this.pending; this.pending = null;
    p?.reject(Object.assign(new Error("Conversion cancelled."), { code: "cancelled" }));
  }
}

export class RenderClient {
  private worker = new Worker(new URL("../worker/render.worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private waiting = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<FromRenderWorker>) => {
      const m = ev.data;
      const key = m.type === "opened" ? "open:" + m.key : m.type === "rendered" ? m.reqId : m.reqId ?? "open:" + m.key;
      const w = this.waiting.get(key);
      if (!w) return;
      this.waiting.delete(key);
      if (m.type === "render-error") w.reject(new Error(m.message)); else w.resolve(m);
    };
  }

  open(key: string, bytes: ArrayBuffer, password?: string): Promise<{ pageCount: number }> {
    return new Promise((resolve, reject) => {
      this.waiting.set("open:" + key, { resolve, reject });
      const copy = bytes.slice(0);
      this.worker.postMessage({ type: "open", key, bytes: copy, password } satisfies ToRenderWorker, [copy]);
    });
  }

  render(key: string, page: number, width: number): Promise<{ png: ArrayBuffer; width: number; height: number }> {
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(reqId, { resolve, reject });
      this.worker.postMessage({ type: "render", reqId, key, page, width } satisfies ToRenderWorker);
    });
  }

  close(key: string) { this.worker.postMessage({ type: "close", key } satisfies ToRenderWorker); }
}
