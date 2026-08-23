/* カーネル版の出力層（重みファイルB）。
 *
 *   予測 = Σ a[j] · exp(-γ‖x − sv_j‖²)
 *
 * ‖x − sv‖² = ‖x‖² + ‖sv‖² − 2 x·sv なので、内積は γ に依存しない。
 * 内積を1回だけ回し、γ の種類ぶんだけ exp を掛け直す。
 * 外部依存なし。Float32Array と DataView だけで読む。
 */
var SeisekiHeadKRR = (function () {
  'use strict';

  function load(buf) {
    var dv = new DataView(buf);
    var hlen = dv.getUint32(0, true);
    var hdr = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf, 4, hlen)));
    /* JS の % は負数で負を返すので (-p)%4 は使えない。Python 側の (-p)%4 と揃える */
    var pad4 = function (q) { return q + ((4 - (q % 4)) % 4); };
    var p = pad4(4 + hlen);
    var m = hdr.m, d = hdr.d, nout = hdr.n_out;
    var Q = new Int8Array(buf, p, m * d); p = pad4(p + m * d);
    var sc = new Float32Array(buf, p, m); p += 4 * m;
    var n2 = new Float32Array(buf, p, m); p += 4 * m;
    var C = new Float32Array(buf, p, nout * m);

    /* order の各名前が C の何行目から始まるか */
    var off = {}, r = 0, W = { band: 7, cat: hdr.cats.length, tt: (hdr.tts || []).length };
    for (var i = 0; i < hdr.order.length; i++) {
      var nm = hdr.order[i];
      off[nm] = r; r += (W[nm] || 1);
    }
    if (r !== nout) throw new Error('出力行数が合いません: ' + r + ' vs ' + nout);

    var dot = new Float64Array(m), K = new Float64Array(m);

    function kernelAt(gamma, xn2) {
      for (var j = 0; j < m; j++) {
        var dd = xn2 + n2[j] - 2 * dot[j];
        K[j] = dd <= 0 ? 1 : Math.exp(-gamma * dd);
      }
    }
    function dual(row) {
      var base = row * m, s = 0;
      for (var j = 0; j < m; j++) s += K[j] * C[base + j];
      return s;
    }

    return {
      hdr: hdr, dim: d, m: m,
      /* x: 長さ d の正規化済みベクトル → 生の出力をまとめて返す */
      score: function (x) {
        var j, k, s, base, xn2 = 0;
        for (k = 0; k < d; k++) xn2 += x[k] * x[k];
        for (j = 0; j < m; j++) {
          base = j * d; s = 0;
          for (k = 0; k < d; k++) s += x[k] * Q[base + k];
          dot[j] = s * sc[j];
        }
        /* γ が同じ項目はまとめて1回の exp で済ませる（順序は order に従う） */
        var g = hdr.gamma, out = {}, groups = {};
        for (var i2 = 0; i2 < hdr.order.length; i2++) {
          var nm2 = hdr.order[i2], gv = g[nm2];
          (groups[gv] || (groups[gv] = [])).push(nm2);
        }
        Object.keys(groups).forEach(function (gv) {
          kernelAt(parseFloat(gv), xn2);
          groups[gv].forEach(function (nm3) {
            var w = W[nm3] || 1;
            if (w === 1) { out[nm3] = dual(off[nm3]); return; }
            var arr = [];
            for (var q = 0; q < w; q++) arr.push(dual(off[nm3] + q));
            out[nm3] = arr;
          });
        });
        return out;
      }
    };
  }

  return { load: load };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiHeadKRR;
