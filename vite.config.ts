import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages serves the site from /<repo>/
export default defineConfig({
  base: process.env.BASE_PATH ?? "/dark-pdf-converter/",
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ["mupdf"] }, // keeps import.meta.url valid for the .wasm file
});
