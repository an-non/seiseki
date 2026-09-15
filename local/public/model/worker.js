/* 声析 ローカル判定 — 別レーン側（Web Worker）
 *
 * 画面を止めないために、判定の計算をこちらに移す。
 * この中から画面は触れない。やりとりは postMessage だけ。
 *
 * 受け取る手紙:
 *   {type:'init', urls:{enc,head,tok,wasm}}      … 自分で取りに行く
 *   {type:'init', buffers:{enc,head,tok,wasm}}   … 受け取ったものを使う
 *   {type:'analyze', id, texts:[...], defaultTarget, mode}
 *        mode: 'response'（既定・chunks まで作る） / 'plain'（判定だけ）
 *   {type:'cancel', id}
 *
 * 送る手紙:
 *   {type:'ready', info:{...}}
 *   {type:'progress', id, done, total}
 *   {type:'item', id, index, result}      … 1件終わるたび
 *   {type:'done', id, count, ms}
 *   {type:'cancelled', id, done}
 *   {type:'error', id, message}
 */
/* global importScripts, SeisekiTokenizer, SeisekiEncoderWasm, SeisekiLocal, SeisekiHeadKRR, SeisekiChunks */
(function (self) {
  'use strict';

  /* ブラウザの Worker ではここで読み込む。Node の試験では外から入れるので飛ばす。 */
  if (typeof importScripts === 'function' && typeof SeisekiTokenizer === 'undefined') {
    importScripts('tokenizer.js', 'encoder-wasm.js', 'head-krr.js', 'local.js', 'chunks.js');
  }

  var loc = null, C = null, cancelled = {};

  /* setTimeout(0) はネストすると4ミリ秒待たされる。MessageChannel なら待たされない。 */
  var yieldChan = (typeof MessageChannel !== 'undefined') ? new MessageChannel() : null;
  var yieldQueue = [];
  if (yieldChan) {
    yieldChan.port1.onmessage = function () {
      var f = yieldQueue.shift();
      if (f) f();
    };
  }
  function nextTick(fn) {
    if (yieldChan) { yieldQueue.push(fn); yieldChan.port2.postMessage(0); }
    else setTimeout(fn, 0);
  }

  function post(m) { self.postMessage(m); }

  function fetchBuf(u) {
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error(u + ' が取得できません (' + r.status + ')');
      return r.arrayBuffer();
    });
  }

  function build(bufs) {
    var tok = new SeisekiTokenizer.Tokenizer(
      JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(bufs.tok))));
    var enc = SeisekiEncoderWasm.create(bufs.enc, bufs.wasm);
    var head = SeisekiHeadKRR.load(bufs.head);
    loc = new SeisekiLocal.Local(tok, enc, head);
    C = (typeof SeisekiChunks !== 'undefined') ? SeisekiChunks : null;
    return {
      vocab: tok.vocab ? tok.vocab.length : 0,
      dim: head.dim, support: head.m, bytes: enc.bytes || 0
    };
  }

  function onInit(msg) {
    var t0 = Date.now();
    var got = function (bufs) {
      var info = build(bufs);
      info.ms = Date.now() - t0;
      post({ type: 'ready', info: info });
    };
    if (msg.buffers) {
      try { got(msg.buffers); }
      catch (e) { post({ type: 'error', id: null, message: String(e && e.message || e) }); }
      return;
    }
    var u = msg.urls;
    Promise.all([fetchBuf(u.tok), fetchBuf(u.enc), fetchBuf(u.head), fetchBuf(u.wasm)])
      .then(function (a) { got({ tok: a[0], enc: a[1], head: a[2], wasm: a[3] }); })
      .catch(function (e) { post({ type: 'error', id: null, message: String(e && e.message || e) }); });
  }

  function onAnalyze(msg) {
    if (!loc) { post({ type: 'error', id: msg.id, message: 'まだ読み込めていません' }); return; }
    var texts = msg.texts || [], i = 0, t0 = Date.now();
    var mode = msg.mode || 'response';
    var dt = msg.defaultTarget || null;
    var maxc = msg.maxChunks || 5;

    function step() {
      if (cancelled[msg.id]) {
        delete cancelled[msg.id];
        post({ type: 'cancelled', id: msg.id, done: i });
        return;
      }
      if (i >= texts.length) {
        post({ type: 'done', id: msg.id, count: texts.length, ms: Date.now() - t0 });
        return;
      }
      var r;
      try {
        r = (mode === 'plain' || !C) ? loc.analyze(texts[i])
                                     : loc.analyzeResponse(texts[i], C, maxc, dt);
      } catch (e) {
        post({ type: 'error', id: msg.id, message: '第' + (i + 1) + '件でつまずきました: ' +
               String(e && e.message || e) });
        return;
      }
      post({ type: 'item', id: msg.id, index: i, result: r });
      i++;
      post({ type: 'progress', id: msg.id, done: i, total: texts.length });
      /* MessageChannel は速いが、環境によっては他の手紙を待たせることがある。
         8件に1回はタイマー経由にして、中止の手紙が必ず割り込めるようにする。 */
      if (i % 8 === 0) setTimeout(step, 0); else nextTick(step);
    }
    nextTick(step);
  }

  self.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.type === 'init') onInit(m);
    else if (m.type === 'analyze') onAnalyze(m);
    else if (m.type === 'cancel') cancelled[m.id] = true;
  };
})(typeof self !== 'undefined' ? self : this);
