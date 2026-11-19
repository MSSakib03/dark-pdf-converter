import { useRef, useState } from "react";
import { Icon } from "./Icon";

export function DropZone({ onFiles, compact }: { onFiles: (f: File[]) => void; compact: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}
      className={`rounded-2xl border-2 border-dashed transition-colors ${over ? "border-amber-300 bg-amber-300/5" : "border-white/10 bg-white/[0.02]"} ${compact ? "p-4" : "p-8"}`}
    >
      <input ref={input} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden
        onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <div className={`flex ${compact ? "flex-row items-center gap-3" : "flex-col items-center text-center gap-3"}`}>
        <span className={`grid place-items-center rounded-xl bg-amber-300/10 text-amber-300 ${compact ? "size-10" : "size-14"}`}><Icon name="upload" className={compact ? "size-5" : "size-7"} /></span>
        <div className={compact ? "flex-1 min-w-0" : ""}>
          <p className="font-medium">{compact ? "Add more files" : "Drop PDF or Word files here"}</p>
          {!compact && <p className="text-sm text-zinc-400 mt-1">PDF, scanned PDF, DOCX · several at once</p>}
        </div>
        <button onClick={() => input.current?.click()} className="btn-primary">Choose files</button>
      </div>
    </div>
  );
}
