/* 暗号化されていない接続（http://）用の代替。
 *
 * ブラウザは安全のため、暗号化されていない接続では次の2つを丸ごと隠します。
 *   ・caches（Cache Storage）… モデルの置き場
 *   ・crypto.subtle          … SHA256 の照合
 * つまり http:// では、照合だけでなく **保管そのものができません**。
 *
 * ここでは同じ形の代わりを用意します。
 *   ・置き場   → IndexedDB（http でも使える）
 *   ------ ・照合     → SHA256 を自前で計算（外部ライブラリなし）
 *
 * 【重要】http:// でのハッシュ照合は、**壊れの検出にしかなりません。**
 *   一覧（manifest）も同じ暗号化されていない経路で取ってくるので、
 *   途中で誰かが両方すり替えたら気づけません。改ざん対策にはなりません。
 *   本番は必ず https:// にしてください。
 */
var SeisekiStoreFallback = (function () {
  'use strict';

  /* ---------------- SHA-256（自前） ---------------- */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

  function sha256(buf) {
    var m = new Uint8Array(buf), len = m.length;
    var withPad = Math.ceil((len + 9) / 64) * 64;   /* 64バイト境界まで伸ばす */
    var b = new Uint8Array(withPad);
    b.set(m); b[len] = 0x80;
    var hi = Math.floor(len / 0x20000000), lo = (len << 3) >>> 0;
    var dv = new DataView(b.buffer);
    dv.setUint32(withPad - 8, hi, false);
    dv.setUint32(withPad - 4, lo, false);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Int32Array(64);
    var rr = function (x, n) { return (x >>> n) | (x << (32 - n)); };

    for (var off = 0; off < withPad; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15] >>> 0, 7) ^ rr(w[i - 15] >>> 0, 18) ^ (w[i - 15] >>> 3);
        var s1 = rr(w[i - 2] >>> 0, 17) ^ rr(w[i - 2] >>> 0, 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rr(e >>> 0, 6) ^ rr(e >>> 0, 11) ^ rr(e >>> 0, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rr(a >>> 0, 2) ^ rr(a >>> 0, 13) ^ rr(a >>> 0, 22);
        var mj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32), o = new DataView(out.buffer);
    for (var j = 0; j < 8; j++) o.setUint32(j * 4, H[j] >>> 0, false);
    return out.buffer;
  }

  /* 19MB だと 0.5秒ほどかかる。まとめて回すと画面が止まるので、
     1MBごとに順番を譲りながら計算する版も用意する。 */
  function sha256Async(buf, perTick) {
    var m = new Uint8Array(buf), len = m.length;
    var withPad = Math.ceil((len + 9) / 64) * 64;
    var b = new Uint8Array(withPad);
    b.set(m); b[len] = 0x80;
    var dv = new DataView(b.buffer);
    dv.setUint32(withPad - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(withPad - 4, (len << 3) >>> 0, false);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Int32Array(64), off = 0;
    var step = (perTick || 16384) * 64;              /* 既定 1MB ずつ */
    var rr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
    return new Promise(function (res) {
      function chunk() {
        var stop = Math.min(withPad, off + step);
        for (; off < stop; off += 64) {
          var i;
          for (i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
          for (i = 16; i < 64; i++) {
            var s0 = rr(w[i - 15] >>> 0, 7) ^ rr(w[i - 15] >>> 0, 18) ^ (w[i - 15] >>> 3);
            var s1 = rr(w[i - 2] >>> 0, 17) ^ rr(w[i - 2] >>> 0, 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
          }
          var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
          for (i = 0; i < 64; i++) {
            var S1 = rr(e >>> 0, 6) ^ rr(e >>> 0, 11) ^ rr(e >>> 0, 25);
            var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
            var S0 = rr(a >>> 0, 2) ^ rr(a >>> 0, 13) ^ rr(a >>> 0, 22);
            var t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = bb; bb = a; a = (t1 + t2) | 0;
          }
          H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
          H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
        }
        if (off < withPad) { setTimeout(chunk, 0); return; }
        var out = new Uint8Array(32), o = new DataView(out.buffer);
        for (var j = 0; j < 8; j++) o.setUint32(j * 4, H[j] >>> 0, false);
        res(out.buffer);
      }
      chunk();
    });
  }

  /* crypto.subtle と同じ形（Promise を返す）で使えるようにする */
  var subtle = { digest: function (algo, buf) { return sha256Async(buf); } };

  /* ---------------- 置き場（IndexedDB） ---------------- */
  /* caches と同じ形だけ用意する: open / keys / delete、
     open の戻りに match / put / delete */
  function makeCaches(idb, dbName) {
    idb = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    dbName = dbName || 'seiseki-model';
    if (!idb) return null;

    function open() {
      return new Promise(function (res, rej) {
        var r = idb.open(dbName, 1);
        r.onupgradeneeded = function () {
          var db = r.result;
          if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }

    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction('blobs', mode), s = t.objectStore('blobs'), out;
          try { out = fn(s); } catch (e) { rej(e); return; }
          /* fn が返すのは IDBRequest か、何も返さないかのどちらか。
             見つからなかったとき result は undefined になるので、
             「undefined でなければ result」という判定にすると
             要求そのものを返してしまう（＝いつでも見つかった扱いになる）。 */
          var unwrap = function (v) {
            return (v && typeof v === 'object' && 'result' in v) ? v.result : v;
          };
          t.oncomplete = function () { db.close(); res(unwrap(out)); };
          t.onerror = function () { db.close(); rej(t.error); };
          t.onabort = function () { db.close(); rej(t.error || new Error('中断されました')); };
        });
      });
    }

    var K2 = function (name, key) { return name + ' ' + key; };

    return {
      open: function (name) {
        return Promise.resolve({
          match: function (key) {
            return tx('readonly', function (s) { return s.get(K2(name, key)); })
              .then(function (v) { return v ? new Response(v) : undefined; });
          },
          put: function (key, resp) {
            return resp.arrayBuffer().then(function (b) {
              return tx('readwrite', function (s) { s.put(new Uint8Array(b), K2(name, key)); });
            });
          },
          delete: function (key) {
            return tx('readwrite', function (s) { s.delete(K2(name, key)); }).then(function () { return true; });
          }
        });
      },
      keys: function () {
        return tx('readonly', function (s) { return s.getAllKeys(); }).then(function (ks) {
          var seen = {};
          (ks || []).forEach(function (k) { seen[String(k).split(' ')[0] ] = 1; });
          return Object.keys(seen);
        });
      },
      delete: function (name) {
        return tx('readonly', function (s) { return s.getAllKeys(); }).then(function (ks) {
          var mine = (ks || []).filter(function (k) { return String(k).indexOf(name + ' ') === 0; });
          return tx('readwrite', function (s) { mine.forEach(function (k) { s.delete(k); }); })
            .then(function () { return mine.length > 0; });
        });
      }
    };
  }

  /* いまの環境に合ったものを選ぶ */
  function pick(opt) {
    opt = opt || {};
    var haveCaches = opt.caches || (typeof caches !== 'undefined' ? caches : null);
    var haveSubtle = opt.subtle ||
      (typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null);
    var usedFallback = { store: false, digest: false };
    if (!haveCaches) { haveCaches = makeCaches(opt.indexedDB, opt.dbName); usedFallback.store = true; }
    if (!haveSubtle) { haveSubtle = subtle; usedFallback.digest = true; }
    return { caches: haveCaches, subtle: haveSubtle, fallback: usedFallback,
             secure: (typeof isSecureContext === 'undefined') ? null : isSecureContext };
  }

  return { sha256: sha256, sha256Async: sha256Async, subtle: subtle, makeCaches: makeCaches, pick: pick };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiStoreFallback;
