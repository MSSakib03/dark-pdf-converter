import type { CSSProperties } from "react";

const PATHS: Record<string, string> = {
  upload: "M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2",
  download: "M12 4v12m0 0l-4-4m4 4l4-4M4 18v0a2 2 0 002 2h12a2 2 0 002-2",
  x: "M6 6l12 12M18 6L6 18",
  moon: "M20 14.5A8.5 8.5 0 119.5 4a6.5 6.5 0 0010.5 10.5z",
  lock: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z",
  palette: "M12 3a9 9 0 100 18c1 0 1.5-.8 1.5-1.5 0-1-.8-1.4-.8-2.3 0-.9.7-1.7 1.7-1.7H17a4 4 0 004-4c0-4.7-4-8.5-9-8.5zM7.5 12h.01M10 7.5h.01M15 7.5h.01",
  "chevron-left": "M15 6l-6 6 6 6",
  "chevron-right": "M9 6l6 6-6 6",
};

export function Icon({ name, className, style }: { name: string; className?: string; style?: CSSProperties }) {
  if (name === "github") {
    return (
      <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
        <path d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 015 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0012 2z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
