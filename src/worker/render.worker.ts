// Preview worker: renders pages of original / converted PDFs to PNG.
import * as mupdf from "mupdf";
import type { ToRenderWorker, FromRenderWorker } from "../lib/protocol";

const docs = new Map<string, mupdf.Document>();
const post = (msg: FromRenderWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<ToRenderWorker>) => {
  const msg = ev.data;
  try {
    if (msg.type === "open") {
      docs.get(msg.key)?.destroy();
      const doc = mupdf.Document.openDocument(new Uint8Array(msg.bytes), "application/pdf");
      if (doc.needsPassword() && msg.password) doc.authenticatePassword(msg.password);
      docs.set(msg.key, doc);
      post({ type: "opened", key: msg.key, pageCount: doc.countPages() });
    } else if (msg.type === "render") {
      const doc = docs.get(msg.key);
      if (!doc) throw new Error("Document not open");
      const page = doc.loadPage(Math.min(Math.max(0, msg.page), doc.countPages() - 1));
      const b = page.getBounds();
      const scale = msg.width / (b[2] - b[0]);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      const png = pix.asPNG().slice();
      const out = { type: "rendered" as const, reqId: msg.reqId, png: png.buffer as ArrayBuffer, width: pix.getWidth(), height: pix.getHeight() };
      pix.destroy(); page.destroy();
      post(out, [out.png]);
    } else if (msg.type === "close") {
      docs.get(msg.key)?.destroy();
      docs.delete(msg.key);
    }
  } catch (e) {
    post({ type: "render-error", reqId: "reqId" in msg ? msg.reqId : undefined, key: "key" in msg ? msg.key : undefined, message: (e as Error).message });
  }
};
