/* 声析 ローカルモデルの橋渡し
 *
 *   ui.jsx から触るのはここ1本だけ。
 *
 *   決めごと（2026-08-21 改訂）:
 *     ・受け取り(20.6MB)は「画面から明示的に頼まれたとき」だけ始める。
 *       判定のついでに勝手に始めない。
 *     ・判定のときは待たない。まだ使えなければ、その場で従来の規則解析へ落とす。
 *     ・「持っているか」は置き場を実際に見て答える。旗を別に持たない
 *       （キャッシュだけ消えたときに嘘になるため）。
 *
 *   前提: index.html で次を先に読み込んでおくこと
 *     store-fallback.js / model-store.js / local-client.js / bootstrap.js
 *
 *   使い方（ui.jsx 側）:
 *     SeisekiLocalBridge.resume();                  // 起動時。受け取り済みなら読み込むだけ
 *     SeisekiLocalBridge.status()                   // {state, have, total}
 *     SeisekiLocalBridge.begin({onState,onProgress,onError})   // ［受け取る］を押されたとき
 *     SeisekiLocalBridge.cancel()                   // ［中止］
 *     SeisekiLocalBridge.remove()                   // ［削除］
 *     await SeisekiLocalBridge.analyze(resp, questions, heuristicAnalysis)
 */
var SeisekiLocalBridge = (function () {
  'use strict';

  var ENGINE = 'seiseki-local-v1';       // sanitizeAnalysis の engine 上限は24字
  var MODEL_BASE = '/model/';
  /* 別レーンが黙り込んだときの打ち切り。
     local-client.js の約束は別レーンからの返事でしか解けないので、
     返事が来なければ送信ボタンが永久に戻らない。ここで必ず断ち切る。 */
  var ANALYZE_TIMEOUT_MS = 20000;
  var boot = null;
  var lastError = null;
  var opts = {};

  function available() {
    return typeof SeisekiBootstrap !== 'undefined'
        && typeof SeisekiModelStore !== 'undefined'
        && typeof SeisekiLocalClient !== 'undefined';
  }

  /* 器だけ作る。ここでは受け取りも読み込みも始まらない */
  function getBoot(o) {
    if (o) {
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) opts[k] = o[k];
    }
    if (!boot && available()) {
      boot = SeisekiBootstrap.create({
        manifestUrl: MODEL_BASE + 'manifest.json',
        workerUrl: MODEL_BASE + 'worker.js',
        onState: function (s, st) { if (opts.onState) opts.onState(s, st); },
        onProgress: function (d, t) { if (opts.onProgress) opts.onProgress(d, t); },
        onError: function (e) { lastError = e; if (opts.onError) opts.onError(e); }
      });
    }
    return boot;
  }

  /* いま端末が持っている量。受け取りは始めない。
     state は 'unsupported' / 'none' / 'partial' / 'ready' */
  function status() {
    var b = getBoot();
    if (!b) return Promise.resolve({ state: 'unsupported', have: 0, total: 0 });
    return b.status().catch(function (e) {
      lastError = e;
      return { state: 'none', have: 0, total: 0 };
    });
  }

  /* ［受け取る］を押されたときだけ呼ぶ。失敗しても投げない（画面を壊さない） */
  function begin(o) {
    var b = getBoot(o);
    if (!b) { lastError = { code: 'unsupported' }; return Promise.resolve(null); }
    return b.begin();
  }

  /* 起動時に呼ぶ。すでに受け取り済みのときだけ、別レーンへ読み込む。
     まだ持っていなければ何もしない（勝手に20.6MBを取りに行かない）。 */
  function resume(o) {
    if (o) getBoot(o);
    if (!available()) return Promise.resolve(null);
    return status().then(function (s) {
      if (s && s.state === 'ready') return begin();
      return null;
    }).catch(function () { return null; });
  }

  function state() { return boot ? boot.state : 'none'; }
  function error() { return lastError; }
  function cancel() { if (boot) boot.cancel(); }
  function retry() { return boot ? boot.retry().catch(function () { return null; }) : begin(); }

  /* この調査そのものの対象。住民は自分の自治体名を書かないことが多く、規則では拾えない */
  function defaultTarget() { return opts.defaultTarget || null; }

  /* 判定できる状態か。ここが false なら analyze は規則解析へ落とす */
  function ready() { return !!boot && boot.state === 'ready'; }

  /* 本体。fallback は従来の heuristicAnalysis をそのまま渡してもらう。
     使えないときは待たずに即座に fallback を返す。 */
  function analyze(resp, questions, fallback) {
    var text = String((resp && resp.free) || '');
    var fb = function () {
      return Promise.resolve(fallback ? fallback(resp, questions) : null);
    };
    if (!text.trim()) return fb();
    if (!available()) return fb();
    if (!ready()) return fb();            /* 受け取っていない・読み込み中 → 待たない */

    var settled = false;
    var timer = null;
    var guard = new Promise(function (res) {
      timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        lastError = { code: 'timeout', message: '端末内の解析が時間内に終わりませんでした' };
        res(fb());
      }, ANALYZE_TIMEOUT_MS);
    });

    var work = boot.ready().then(function (client) {
      if (!client) return fb();
      return client.analyze(text, {
        mode: 'response',
        maxChunks: 5,
        defaultTarget: defaultTarget()
      }).then(function (a) {
        if (!a) return fb();
        a.engine = ENGINE;
        a.ai = false;                     // AIではない、と画面に伝える
        return a;
      });
    }).catch(function (e) {
      lastError = e;
      return fb();
    }).then(function (r) {
      settled = true;
      if (timer) clearTimeout(timer);
      return r;
    });

    /* 先に決まったほうを採る。打ち切られても、あとから返事が来たら黙って捨てる。 */
    return Promise.race([work, guard]);
  }

  function remove() {
    if (!boot) { var b = getBoot(); if (!b) return Promise.resolve(); }
    return boot.remove().catch(function (e) { lastError = e; });
  }

  return {
    ENGINE: ENGINE,
    available: available, status: status, resume: resume,
    begin: begin, cancel: cancel, retry: retry, remove: remove,
    ready: ready, state: state, error: error, analyze: analyze,
    setDefaultTarget: function (t) { opts.defaultTarget = t; }
  };
})();

/* ここには module.exports を書かない。
   このファイルは build-app.mjs が App.jsx へ連結するため、バンドラが
   ESM の中の CommonJS とみなして毎回警告を出す（動作に害は無いが、
   本当の警告が埋もれる）。Node での検査は tests/local-bridge.test.js が
   ファイルを読んで評価する形にしてある。 */
