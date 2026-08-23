import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const quantumEntry = resolve(rootDir, "quantum/chunk-network-entanglement-preview.html");
const input = {
  main: resolve(rootDir, "index.html")
};

if (existsSync(quantumEntry)) input.quantum = quantumEntry;

export default defineConfig({
  plugins: [react()],
  input,
  build: {
    // Vite 8 defaults to Safari 16.4+. Lower the syntax target so older Mac
    // Safari/WebKit can load the dashboard and the bundled quantum renderer.
    target: ["safari14", "ios14", "chrome87", "edge88", "firefox78"]
  },
  server: { port: 3000, open: true }
});
