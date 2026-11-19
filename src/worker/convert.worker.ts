// Conversion worker: runs the engine off the main thread so the UI never freezes.
import * as mupdf from "mupdf";
import * as fflate from "fflate";
import { convertPdf, ConversionError } from "../engine/pdf.js";
import { convertDocx } from "../engine/docx.js";
import type { ToConvertWorker, FromConvertWorker, ConversionReport } from "../lib/protocol";

const post = (msg: FromConvertWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<ToConvertWorker>) => {
  const msg = ev.data;
  if (msg.type !== "convert") return;
  const { jobId, bytes, theme, options } = msg;
  const input = new Uint8Array(bytes);
  try {
    const isZip = input[0] === 0x50 && input[1] === 0x4b;
    // "%PDF" may be preceded by junk bytes; the spec allows the header anywhere in the first 1 KB
    const head = new TextDecoder("latin1").decode(input.subarray(0, 1024));
    const isPdf = head.includes("%PDF");
    const onProgress = (p: { page: number; total: number; stage: string }) => post({ type: "progress", jobId, ...p });
    let result: { bytes: Uint8Array; report: ConversionReport };
    let kind: "pdf" | "docx";
    if (isZip) {
      result = convertDocx(mupdf, fflate, input, { theme, onProgress }) as typeof result;
      kind = "docx";
    } else if (isPdf) {
      result = convertPdf(mupdf, input, { theme, password: options.password, imageMode: options.imageMode, onProgress }) as typeof result;
      kind = "pdf";
    } else {
      throw new ConversionError("unsupported", "Unsupported file type. Please choose a PDF or DOCX file.");
    }
    const out = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
    post({ type: "done", jobId, kind, output: out, report: result.report }, [out]);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    post({ type: "error", jobId, code: err.code ?? "internal", message: err.code ? err.message ?? "Error" : "Something went wrong while converting this file. " + (err.message ?? "") });
  }
};

post({ type: "ready" });
