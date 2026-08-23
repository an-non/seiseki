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
  build: {
    // Safari 15.1 is the oldest browser currently verified by the project.
    // Keep syntax output below that ceiling and make the quantum page a real
    // Vite HTML entry so its bare `three` imports are bundled instead of
    // depending on import maps (unsupported in Safari <=16.3).
    target: ["safari14", "ios14", "chrome87", "edge88", "firefox78"],
    cssTarget: "safari14",
    modulePreload: { polyfill: true },
    rollupOptions: { input }
  },
  server: { port: 3000, open: true }
});
