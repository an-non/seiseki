/* 声析 ローカル判定 — モデルの受け取りと保管
 *
 * 初回ログイン時に裏で受け取り、端末に置いておく。2回目からは取りに行かない。
 *
 *   var st = new SeisekiModelStore(manifest);
 *   st.status().then(function (s) { ... s.state は 'none' / 'partial' / 'ready' ... });
 *   var job = st.ensure({
 *     onProgress: function (done, total) { bar.style.width = (100*done/total) + '%'; }
 *   });
 *   job.then(function () { ... 使えるようになった ... })
 *      .catch(function (e) { ... e.code で場合分け ... });
 *   job.cancel();
 *
 * manifest の形:
 *   { version: "2026-08-14",
 *     files: [ {key:"enc",  url:"/model/encoder.bin",  bytes:19891712, sha256:"d287..."},
 *              {key:"head", url:"/model/head.bin",     bytes: 917148, sha256:"6615..."}, ... ] }
 *
 * 決めごと:
 *   ・2MB ずつに分けて受け取る。途中で切れても、受け取った分は残る
 *   ・配信元が途中からの受け取り(Range)に対応していなくても止まらない。
 *     全部が返ってきたら、流れてくるそばから2MBずつに切って保管する（記憶は2MBしか使わない）
 *   ・全部そろったら SHA256 を照合し、合わなければ捨ててやり直す
 *   ・版が変わったら古い版はまとめて消す
 *   ・失敗の理由は e.code で分かる形にする（offline / http / quota / corrupt / aborted / unknown）
 */
var SeisekiStoreFallback;
var SeisekiModelStore = (function () {
  'use strict';

  /* Node で試すときはここから読む。ブラウザは <script> で先に読み込んでおく */
  if (typeof SeisekiStoreFallback === 'undefined' &&
      typeof module !== 'undefined' && module.exports) {
    try { SeisekiStoreFallback = require('./store-fallback.js'); } catch (e) { /* 無くても動く */ }
  }

  var PART = 2 * 1024 * 1024;

  function err(code, message, extra) {
    var e = new Error(message);
    e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  function hex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  function Store(manifest, opt) {
    opt = opt || {};
    this.m = manifest;
    this.name = opt.cacheName || ('seiseki-model-' + manifest.version);
    this.part = opt.partSize || PART;
    /* 暗号化されていない接続では caches も crypto.subtle も使えない。
       その場合は store-fallback.js（IndexedDB ＋ 自前SHA256）に切り替える。 */
    var pick = (typeof SeisekiStoreFallback !== 'undefined')
      ? SeisekiStoreFallback.pick(opt)
      : { caches: opt.caches || (typeof caches !== 'undefined' ? caches : null),
          subtle: opt.subtle || (typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null),
          fallback: { store: false, digest: false }, secure: null };
    this.caches = pick.caches;
    this.subtle = pick.subtle;
    this.fallback = pick.fallback;
    this.secure = pick.secure;
    this.fetch = opt.fetch || (typeof fetch !== 'undefined' ? fetch.bind(null) : null);
    this.online = opt.online || function () {
      return (typeof navigator === 'undefined') || navigator.onLine !== false;
    };
    /* 配信元が途中からの受け取りに対応していたか。null=まだ分からない */
    this.rangeOk = null;
    if (!this.caches) throw err('unsupported', 'この環境には保管場所がありません');
  }

  Store.prototype.total = function () {
    return this.m.files.reduce(function (a, f) { return a + f.bytes; }, 0);
  };

  Store.prototype._parts = function (f) {
    var n = Math.max(1, Math.ceil(f.bytes / this.part)), a = [];
    for (var i = 0; i < n; i++) {
      var s = i * this.part, e = Math.min(f.bytes, s + this.part) - 1;
      a.push({ i: i, start: s, end: e, key: f.url + '?p=' + i, bytes: e - s + 1 });
    }
    return a;
  };

  /* いま何バイト持っているか */
  Store.prototype.status = function () {
    var self = this;
    return this.caches.open(this.name).then(function (c) {
      var jobs = self.m.files.map(function (f) {
        return c.match(f.url).then(function (r) {
          if (r) return { full: true, have: f.bytes };
          var ps = self._parts(f);
          return Promise.all(ps.map(function (p) {
            return c.match(p.key).then(function (x) { return x ? p.bytes : 0; });
          })).then(function (v) {
            return { full: false, have: v.reduce(function (a, b) { return a + b; }, 0) };
          });
        });
      });
      return Promise.all(jobs).then(function (a) {
        var have = a.reduce(function (s, x) { return s + x.have; }, 0);
        var full = a.every(function (x) { return x.full; });
        return { state: full ? 'ready' : (have > 0 ? 'partial' : 'none'),
                 have: have, total: self.total() };
      });
    });
  };

  Store.prototype.get = function (key) {
    var f = this.m.files.filter(function (x) { return x.key === key; })[0];
    if (!f) return Promise.reject(err('unknown', key + ' は manifest にありません'));
    return this.caches.open(this.name).then(function (c) {
      return c.match(f.url);
    }).then(function (r) {
      if (!r) throw err('missing', key + ' はまだ受け取れていません');
      return r.arrayBuffer();
    }).then(function (b) {
      if (b.byteLength !== f.bytes) throw err('corrupt', key + ' の大きさが違います');
      return b;
    });
  };

  Store.prototype.remove = function () {
    return this.caches.delete(this.name);
  };

  /* 別の版の置き場を消す */
  Store.prototype.cleanupOld = function () {
    var self = this;
    if (!this.caches.keys) return Promise.resolve(0);
    return this.caches.keys().then(function (ks) {
      var old = ks.filter(function (k) {
        return k.indexOf('seiseki-model-') === 0 && k !== self.name;
      });
      return Promise.all(old.map(function (k) { return self.caches.delete(k); }))
        .then(function () { return old.length; });
    });
  };

  /* 受け取る。返り値の Promise に .cancel() が生えている */
  Store.prototype.ensure = function (opt) {
    opt = opt || {};
    var self = this, aborted = false;
    var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var done = 0, total = this.total();

    function tick() { if (opt.onProgress) opt.onProgress(done, total); }

    function classify(e, url) {
      if (aborted) return err('aborted', '中止しました');
      if (e && e.code) return e;
      if (e && (e.name === 'AbortError')) return err('aborted', '中止しました');
      if (e && e.name === 'QuotaExceededError') {
        return err('quota', '端末の空き容量が足りません', { need: total });
      }
      if (!self.online()) return err('offline', '通信が切れています');
      return err('unknown', '受け取れませんでした（原因を特定できません）',
                 { raw: String(e && (e.message || e)), url: url });
    }

    var p = this.caches.open(this.name).then(function (c) {

      /* 1部品を保管する。すでに持っていれば何もしない */
      function putPart(pt, u8, have) {
        if (have[pt.i]) return Promise.resolve();
        return c.put(pt.key, new Response(u8)).then(function () {
          have[pt.i] = true; done += pt.bytes; tick();
        });
      }

      /* 配信元が Range を無視して「全部」返してきたときの受け皿。
         流れてくるそばから部品の大きさに切って保管するので、記憶は1部品分しか使わない。
         すでに持っている部品は読み飛ばすだけで、書き直さない。 */
      function takeWhole(f, ps, have, r) {
        var idx = 0, buf = null, off = 0;

        function openPart() {
          if (idx >= ps.length) return false;
          buf = new Uint8Array(ps[idx].bytes); off = 0;
          return true;
        }
        /* 同期でその部品を確定させ、保管の仕事だけを返す（順番が入れ替わらないように） */
        function sealPart() {
          var pt = ps[idx], b = buf;
          idx++; buf = null; off = 0;
          return function () { return putPart(pt, b, have); };
        }
        function feed(u8) {
          var chain = Promise.resolve(), o = 0;
          while (o < u8.length) {
            if (!buf && !openPart()) {
              throw err('corrupt', '受け取った大きさが合いません', { url: f.url });
            }
            var n = Math.min(buf.length - off, u8.length - o);
            buf.set(u8.subarray(o, o + n), off);
            off += n; o += n;
            if (off === buf.length) chain = chain.then(sealPart());
          }
          return chain;
        }
        function finish() {
          if (buf || idx !== ps.length) {
            throw err('corrupt', '受け取った大きさが合いません', { url: f.url });
          }
        }

        var body = r.body;
        if (!body || typeof body.getReader !== 'function') {
          /* 分割読みができない環境。まとめて受けてから切る */
          return r.arrayBuffer().then(function (ab) {
            return feed(new Uint8Array(ab));
          }).then(finish);
        }
        var reader = body.getReader();
        function pump() {
          return reader.read().then(function (res) {
            if (aborted) {
              try { reader.cancel(); } catch (e) { /* 無視 */ }
              throw err('aborted', '中止しました');
            }
            if (res.done) return finish();
            var v = res.value;
            /* 写しを取らずに見るだけにする（19.9MB を二重に抱えない） */
            var u8 = (v && v.buffer)
              ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
              : new Uint8Array(v);
            return feed(u8).then(pump);
          });
        }
        return pump();
      }

      /* 足りない部品を順に取りに行く。
         206 が返れば部品ごと。200 が返れば（＝Range 未対応）そこで全部まかなう。 */
      function fetchMissing(f, ps, have, missing) {
        var i = 0;
        function step() {
          if (i >= missing.length) return Promise.resolve();
          if (aborted) return Promise.reject(err('aborted', '中止しました'));
          var pt = missing[i];
          return self.fetch(f.url, {
            signal: ac ? ac.signal : undefined,
            headers: { Range: 'bytes=' + pt.start + '-' + pt.end }
          }).then(function (r) {
            if (r.status === 206) {
              self.rangeOk = true;
              return r.arrayBuffer().then(function (buf) {
                if (buf.byteLength !== pt.bytes) {
                  throw err('corrupt', '受け取った大きさが合いません', { url: f.url });
                }
                return putPart(pt, new Uint8Array(buf), have);
              }).then(function () { i++; return step(); });
            }
            if (r.status === 200) {
              /* 配信元が途中からの受け取りに対応していない。
                 全体が返ってきているので、ここから残りを全部切り出す。 */
              self.rangeOk = false;
              return takeWhole(f, ps, have, r);
            }
            throw err('http', '配信元に接続できませんでした（エラー ' + r.status + '）',
                      { status: r.status, url: f.url });
          });
        }
        return step();
      }

      function doFile(f) {
        return c.match(f.url).then(function (hit) {
          if (hit) { done += f.bytes; tick(); return; }
          var ps = self._parts(f);
          /* いま持っている部品を先に数える */
          return Promise.all(ps.map(function (pt) {
            return c.match(pt.key).then(function (h) { return !!h; });
          })).then(function (have) {
            have.forEach(function (h, i) { if (h) done += ps[i].bytes; });
            tick();
            var missing = ps.filter(function (pt) { return !have[pt.i]; });
            if (!missing.length) return;
            if (aborted) throw err('aborted', '中止しました');
            return fetchMissing(f, ps, have, missing);
          /* 全部そろったら つなげて 照合して 1本にする */
          }).then(function () {
            return Promise.all(ps.map(function (pt) {
              return c.match(pt.key).then(function (r) {
                if (!r) throw err('corrupt', '部品が足りません', { url: f.url });
                return r.arrayBuffer();
              });
            }));
          }).then(function (bufs) {
            var all = new Uint8Array(f.bytes), o = 0;
            bufs.forEach(function (b) { all.set(new Uint8Array(b), o); o += b.byteLength; });
            if (!self.subtle || !f.sha256) return all;      /* 照合できない環境は大きさだけ */
            return self.subtle.digest('SHA-256', all.buffer).then(function (d) {
              if (hex(d) !== String(f.sha256).toLowerCase()) {
                return Promise.all(ps.map(function (pt) { return c.delete(pt.key); }))
                  .then(function () {
                    throw err('corrupt', 'データが壊れていました', { url: f.url });
                  });
              }
              return all;
            });
          }).then(function (all) {
            return c.put(f.url, new Response(all)).then(function () {
              return Promise.all(ps.map(function (pt) { return c.delete(pt.key); }));
            });
          });
        });
      }

      var seq = Promise.resolve();
      self.m.files.forEach(function (f) { seq = seq.then(function () { return doFile(f); }); });
      return seq.then(function () { return self.cleanupOld(); })
                .then(function () { return { ok: true, bytes: total }; });
    }).catch(function (e) { throw classify(e); });

    p.cancel = function () { aborted = true; if (ac) ac.abort(); };
    return p;
  };

  /* 失敗したときに画面へ出す文（案2の方針: 分かる範囲で理由を出し、分からなければそう言う） */
  Store.MESSAGES = {
    offline: '通信が切れたため中断しました。つながると自動で続きから再開します',
    http: '配信元に接続できませんでした。時間をおいて自動でやり直します',
    quota: '端末の空き容量が足りません。約20MB空けてから[再開]を押してください',
    corrupt: 'データが壊れていたため取り直しています',
    /* range はもう投げない（未対応でも全体受信に切り替えて続行する）。
       古い保存済みの版が投げてくる場合に備えて文面だけ残す */
    range: '配信元が途中からの受け取りに未対応のため、まとめて受け取っています',
    aborted: '',
    unsupported: 'このブラウザではオフライン用データを保存できません',
    unknown: 'オフライン用データを受け取れませんでした（原因を特定できません）。' +
             '次のログイン時にやり直します'
  };
  Store.messageFor = function (e) {
    return Store.MESSAGES[(e && e.code) || 'unknown'] || Store.MESSAGES.unknown;
  };

  return Store;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiModelStore;
