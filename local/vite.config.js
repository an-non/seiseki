import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const quantumEntry = resolve(rootDir, "chunk-network-entanglement-preview.html");
const quantumOutput = "quantum/chunk-network-entanglement-preview.html";
const input = {
  main: resolve(rootDir, "index.html"),
  quantum: quantumEntry
};

function placeQuantumPreview() {
  return {
    name: "seiseki-place-quantum-preview",
    apply: "build",
    generateBundle(_options, bundle) {
      const sourceKey = Object.keys(bundle).find(key => bundle[key]?.fileName === "chunk-network-entanglement-preview.html");
      if (!sourceKey) throw new Error("bundled quantum preview HTML was not emitted");
      const entry = bundle[sourceKey];
      delete bundle[sourceKey];
      entry.fileName = quantumOutput;
      bundle[quantumOutput] = entry;
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
    // stays at local/chunk-network-entanglement-preview.html; the build plugin
    // moves only the emitted HTML to the same-origin /quantum/ path used by UI.
    target: ["safari14", "ios14", "chrome87", "edge88", "firefox78"],
    cssTarget: "safari14",
    modulePreload: { polyfill: true },
    rollupOptions: { input }
  },
  server: { port: 3000, open: true }
});
