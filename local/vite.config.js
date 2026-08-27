import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const quantumEntry = resolve(rootDir, "chunk-network-entanglement-preview.html");
const quantumOutput = resolve(rootDir, "dist/quantum/chunk-network-entanglement-preview.html");
const input = {
  main: resolve(rootDir, "index.html"),
  quantum: quantumEntry
};

function placeQuantumPreview() {
  return {
    name: "seiseki-place-quantum-preview",
    apply: "build",
    enforce: "post",
    closeBundle() {
      const emitted = resolve(rootDir, "dist/chunk-network-entanglement-preview.html");
      if (!existsSync(emitted)) throw new Error("bundled quantum preview HTML was not emitted");
      mkdirSync(dirname(quantumOutput), { recursive: true });
      renameSync(emitted, quantumOutput);
    }
  };
}

export default defineConfig({
  plugins: [react(), placeQuantumPreview()],
  build: {
    // Safari 15.1 is the oldest browser currently verified by the project.
    // Keep syntax output below that ceiling and make the quantum page a real
    // Vite HTML entry so its bare `three` imports are bundled instead of
    // depending on import maps (unsupported in Safari <=16.3).  The source
    // stays at local/chunk-network-entanglement-preview.html; after Vite has
    // written the build, only the emitted HTML moves to the same-origin
    // /quantum/ path used by the app UI.
    target: ["safari14", "ios14", "chrome87", "edge88", "firefox78"],
    cssTarget: "safari14",
    modulePreload: { polyfill: true },
    rollupOptions: { input }
  },
  server: { port: 3000, open: true }
});
