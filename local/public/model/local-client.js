/* 声析 ローカル判定 — 画面側の窓口
 *
 * 別レーン（worker.js）に仕事を渡し、進み具合と結果を受け取る。
 * 画面側は判定の中身を一切知らなくてよい。
 *
 *   var lc = new SeisekiLocalClient('/model/worker.js');
 *   lc.load({ enc:'/model/encoder.bin', head:'/model/head.bin',
 *             tok:'/model/tok.json', wasm:'/model/kernel.wasm' })
 *     .then(function (info) { ... 使えるようになった ... });
 *
 *   var job = lc.analyzeAll(texts, {
 *     defaultTarget: { tt:'地方自治体', tn:'品川区' },
 *     onProgress: function (done, total) { bar.style.width = (100*done/total)+'%'; },
 *     onItem:     function (i, r) { ... 1件ずつ描いてもよい ... }
 *   });
 *   job.then(function (results) { ... });
 *   job.cancel();          // 途中でやめる
 */
var SeisekiLocalClient = (function () {
  'use strict';

  function Client(workerUrl) {
    this.url = workerUrl;
    this.w = null;
    this.seq = 0;
    this.jobs = {};
    this.ready = null;
    this.info = null;
  }

  Client.prototype._start = function () {
    if (this.w) return;
    var self = this;
    this.w = new Worker(this.url);
    this.w.onmessage = function (ev) { self._recv(ev.data || {}); };
    this.w.onerror = function (e) {
      var msg = '別レーンでつまずきました: ' + (e.message || '');
      if (self._readyRej) { self._readyRej(new Error(msg)); self._readyRej = null; }
      Object.keys(self.jobs).forEach(function (k) {
        var j = self.jobs[k]; delete self.jobs[k]; j.rej(new Error(msg));
      });
    };
  };

  Client.prototype._recv = function (m) {
    var j = (m.id != null) ? this.jobs[m.id] : null;
    if (m.type === 'ready') {
      this.info = m.info;
      if (this._readyRes) { this._readyRes(m.info); this._readyRes = this._readyRej = null; }
      return;
    }
    if (m.type === 'error') {
      if (j) { delete this.jobs[m.id]; j.rej(new Error(m.message)); }
      else if (this._readyRej) { this._readyRej(new Error(m.message)); this._readyRes = this._readyRej = null; }
      return;
    }
    if (!j) return;
    if (m.type === 'item') {
      j.results[m.index] = m.result;
      if (j.onItem) j.onItem(m.index, m.result);
    } else if (m.type === 'progress') {
      if (j.onProgress) j.onProgress(m.done, m.total);
    } else if (m.type === 'done') {
      delete this.jobs[m.id];
      j.res(j.results);
    } else if (m.type === 'cancelled') {
      delete this.jobs[m.id];
      j.res(j.results.slice(0, m.done));
    }
  };

  /* src は {enc,head,tok,wasm} のURL、または同じ形の ArrayBuffer */
  Client.prototype.load = function (src) {
    var self = this;
    if (this.ready) return this.ready;
    this._start();
    this.ready = new Promise(function (res, rej) {
      self._readyRes = res; self._readyRej = rej;
      var isBuf = src.enc && src.enc.byteLength !== undefined;
      self.w.postMessage(isBuf ? { type: 'init', buffers: src } : { type: 'init', urls: src });
    });
    return this.ready;
  };

  Client.prototype.analyzeAll = function (texts, opt) {
    opt = opt || {};
    var self = this, id = ++this.seq;
    var p = new Promise(function (res, rej) {
      self.jobs[id] = { res: res, rej: rej, results: new Array(texts.length),
                        onProgress: opt.onProgress, onItem: opt.onItem };
      self.w.postMessage({ type: 'analyze', id: id, texts: texts,
                           defaultTarget: opt.defaultTarget || null,
                           maxChunks: opt.maxChunks || 5,
                           mode: opt.mode || 'response' });
    });
    p.cancel = function () { self.w.postMessage({ type: 'cancel', id: id }); };
    return p;
  };

  Client.prototype.analyze = function (text, opt) {
    return this.analyzeAll([text], opt).then(function (a) { return a[0]; });
  };

  Client.prototype.close = function () {
    if (this.w) { this.w.terminate(); this.w = null; this.ready = null; }
  };

  return Client;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiLocalClient;
