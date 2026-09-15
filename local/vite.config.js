import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const quantumEntry = resolve(rootDir, "chunk-network-entanglement-preview.html");
const quantumOutput = resolve(rootDir, "dist/quantum/chunk-network-entanglement-preview.html");
const quantumV2Entry = resolve(rootDir, "quantum-node-relations-v2-preview.html");
const quantumV2Output = resolve(rootDir, "dist/quantum-v2/quantum-node-relations-v2-preview.html");
const DEPLOYED_RUNTIME_CONTRACTS = Object.freeze({
  staging: Object.freeze({
    apiBaseUrl: "https://seiseki-api-staging.tokyo-odh-129.workers.dev",
    apiRequired: true,
    runtimeMode: "staging"
  }),
  production: Object.freeze({
    apiBaseUrl: "https://seiseki-api.tokyo-odh-129.workers.dev",
    apiRequired: true,
    runtimeMode: "production"
  })
});

function runtimeContract(mode) {
  if (DEPLOYED_RUNTIME_CONTRACTS[mode]) return DEPLOYED_RUNTIME_CONTRACTS[mode];
  return {
    apiBaseUrl: process.env.VITE_SEISEKI_API_BASE || "",
    apiRequired: process.env.VITE_SEISEKI_API_REQUIRED === "true",
    runtimeMode: "local"
  };
}

function writeRuntimeManifest(contract) {
  return {
    name: "seiseki-write-runtime-manifest",
    apply: "build",
    closeBundle() {
      writeFileSync(
        resolve(rootDir, "dist/seiseki-runtime.json"),
        `${JSON.stringify({ version: 1, ...contract }, null, 2)}\n`,
        "utf8"
      );
    }
  };
}

function placeQuantumPreview(includeQuantumV2) {
  return {
    name: "seiseki-place-quantum-preview",
    apply: "build",
    enforce: "post",
    closeBundle() {
      const previews = [
        [resolve(rootDir, "dist/chunk-network-entanglement-preview.html"), quantumOutput],
        ...(includeQuantumV2
          ? [[resolve(rootDir, "dist/quantum-node-relations-v2-preview.html"), quantumV2Output]]
          : [])
      ];
      for (const [emitted, output] of previews) {
        if (!existsSync(emitted)) throw new Error(`bundled quantum preview HTML was not emitted: ${emitted}`);
        mkdirSync(dirname(output), { recursive: true });
        renameSync(emitted, output);
      }
    }
  };
}

export default defineConfig(({ mode }) => {
  const contract = runtimeContract(mode);
  const input = {
    main: resolve(rootDir, "index.html"),
    quantum: quantumEntry,
    ...(mode === "production" ? {} : { quantumV2: quantumV2Entry })
  };
  return {
    define: {
      "import.meta.env.VITE_SEISEKI_API_BASE": JSON.stringify(contract.apiBaseUrl),
      "import.meta.env.VITE_SEISEKI_API_REQUIRED": JSON.stringify(String(contract.apiRequired)),
      "import.meta.env.VITE_SEISEKI_RUNTIME_MODE": JSON.stringify(contract.runtimeMode)
    },
    plugins: [react(), placeQuantumPreview(mode !== "production"), writeRuntimeManifest(contract)],
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
  };
});
