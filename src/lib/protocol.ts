// Messages exchanged with the workers.

export interface ThemeColors { bg: string; text: string }
export interface ConvertOptions { password?: string; imageMode: "smart" | "keep" }

export type ToConvertWorker = { type: "convert"; jobId: string; name: string; bytes: ArrayBuffer; theme: ThemeColors; options: ConvertOptions };

export type FromConvertWorker =
  | { type: "ready" }
  | { type: "progress"; jobId: string; page: number; total: number; stage: string }
  | { type: "done"; jobId: string; kind: "pdf" | "docx"; output: ArrayBuffer; report: ConversionReport }
  | { type: "error"; jobId: string; code: string; message: string };

export interface ConversionReport {
  pages?: number;
  ms: number;
  inputBytes: number;
  outputBytes: number;
  warnings: string[];
  pageReports?: { page: number; type: string }[];
}

export type ToRenderWorker =
  | { type: "open"; key: string; bytes: ArrayBuffer; password?: string }
  | { type: "render"; reqId: number; key: string; page: number; width: number }
  | { type: "close"; key: string };

export type FromRenderWorker =
  | { type: "opened"; key: string; pageCount: number }
  | { type: "rendered"; reqId: number; png: ArrayBuffer; width: number; height: number }
  | { type: "render-error"; reqId?: number; key?: string; message: string };
