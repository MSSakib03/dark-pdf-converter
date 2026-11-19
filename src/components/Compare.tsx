import { useRef, useState } from "react";

/** Before/after slider. Drag anywhere (mouse or touch) or use the keyboard on the handle. */
export function Compare({ before, after, ratio }: { before: string; after: string; ratio: number }) {
  const [pos, setPos] = useState(50);
  const ref = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      ref={ref}
      className="relative mx-auto select-none touch-none rounded shadow-2xl overflow-hidden"
      style={{ aspectRatio: `1 / ${ratio}`, maxWidth: `min(100%, calc((100dvh - 11rem) / ${ratio}))` }}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons) move(e.clientX); }}
    >
      <img src={after} alt="Converted page" className="absolute inset-0 size-full" draggable={false} />
      <img src={before} alt="Original page" className="absolute inset-0 size-full" draggable={false} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <div className="absolute inset-y-0 w-0.5 bg-amber-300 shadow-[0_0_0_1px_rgba(0,0,0,.4)]" style={{ left: `${pos}%` }}>
        <button
          aria-label="Before / after position" role="slider" aria-valuenow={Math.round(pos)} aria-valuemin={0} aria-valuemax={100}
          onKeyDown={(e) => { if (e.key === "ArrowLeft") setPos((p) => Math.max(0, p - 5)); if (e.key === "ArrowRight") setPos((p) => Math.min(100, p + 5)); }}
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-9 rounded-full bg-amber-300 text-black grid place-items-center shadow-lg"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M9 6l-6 6 6 6M15 6l6 6-6 6" /></svg>
        </button>
      </div>
      <span className="absolute top-2 left-2 text-[11px] px-1.5 py-0.5 rounded bg-black/60 text-white">Original</span>
      <span className="absolute top-2 right-2 text-[11px] px-1.5 py-0.5 rounded bg-black/60 text-white">Dark</span>
    </div>
  );
}
