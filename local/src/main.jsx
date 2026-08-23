import React from "react";
import { createRoot } from "react-dom/client";

/* ローカル実行用ストレージ(アーティファクト環境の window.storage 相当)。
   App.jsx は読み込み時点で window.storage を参照するため、必ず import より前に定義する。
   localStorage に保存するので、リロードしてもデータは残る。 */
window.storage = {
  async get(k) {
    const v = localStorage.getItem(k);
    if (v === null) throw new Error("not found");
    return { key: k, value: v };
  },
  async set(k, v) { localStorage.setItem(k, v); return { key: k, value: v }; },
  async delete(k) { localStorage.removeItem(k); return { key: k, deleted: true }; },
  async list(p) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(p || "") === 0) keys.push(k);
    }
    return { keys: keys };
  }
};

/* Cloudflare接続と表示モードは分離する。
   APIが有効でもproductionではSTAGING警告を表示しない。 */
const runtimeMode = String(import.meta.env.VITE_SEISEKI_RUNTIME_MODE || "local").toLowerCase();
window.SEISEKI_RUNTIME_MODE = ["local", "staging", "production"].includes(runtimeMode) ? runtimeMode : "local";
window.SEISEKI_API_CONFIG = {
  baseUrl: import.meta.env.VITE_SEISEKI_API_BASE || "",
  required: import.meta.env.VITE_SEISEKI_API_REQUIRED === "true"
};

/* window.storage 定義後にアプリを読み込む(動的import)。
   Vite雛形の index.css / App.css は読み込まない(レイアウトが崩れるため)。 */
const { default: App } = await import("./App.jsx");
createRoot(document.getElementById("root")).render(React.createElement(App));
