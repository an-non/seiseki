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

/* Safari 15.1ではトップレベルawaitを避ける。動的importのPromise連鎖で
   window.storage初期化後にAppを読み込み、エラー時は画面に原因を残す。 */
import("./App.jsx")
  .then(({ default: App }) => {
    const root = document.getElementById("root");
    if (!root) throw new Error("root element is missing");
    createRoot(root).render(React.createElement(App));
  })
  .catch(error => {
    console.error("SEISEKI bootstrap failed", error);
    const root = document.getElementById("root");
    if (root) {
      root.innerHTML = `<div style="padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;color:#7a1f1f">表示初期化エラー: ${String(error && error.message || error || "unknown error")}</div>`;
    }
  });
