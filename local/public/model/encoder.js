/* ModernBERT-ja エンコーダの推論（int8重み・JS版）
 *
 * Python(numpy)版 bert_numpy.py の ModernEncoder と同じ計算を行う。
 * 重みは encoder-int8.bin（"SEIS" コンテナ = 数値だけ / コードを含めない形式）から読む。
 *
 * 使わないものは最初から入っていない:
 *   ・層9（層5と層8までしか使わない）
 *   ・MLMヘッドと final_norm（平均プーリングの前で取り出すため）
 */
var SeisekiEncoder = (function () {
  'use strict';

  function parse(buf) {
    var u8 = new Uint8Array(buf);
    if (!(u8[0] === 83 && u8[1] === 69 && u8[2] === 73 && u8[3] === 83)) throw new Error('形式が違います');
    var dv = new DataView(buf);
    var hlen = dv.getUint32(4, true);
    var hdr = JSON.parse(new TextDecoder('utf-8').decode(u8.subarray(8, 8 + hlen)));
    var base = 8 + hlen, T = {};
    for (var k in hdr.tensors) {
      var m = hdr.tensors[k];
      T[k] = (m.dtype === 'i8') ? new Int8Array(buf, base + m.off, m.len)
        : (m.dtype === 'u4') ? new Uint8Array(buf, base + m.off, m.len)
        : new Float32Array(buf, base + m.off, m.len / 4);
    }
    hdr.T = T;
    return hdr;
  }

  /* Y[n,dout] = X[n,din] @ W8[dout,din]^T * scale[dout] */
  function mmI8(X, n, din, W8, S, dout, Y) {
    for (var r = 0; r < dout; r++) {
      var wo = r * din, s = S[r];
      for (var t = 0; t < n; t++) {
        var xo = t * din, acc = 0.0;
        for (var k = 0; k < din; k++) acc += X[xo + k] * W8[wo + k];
        Y[t * dout + r] = acc * s;
      }
    }
  }

  /* 平均0分散1に揃えてから g を掛ける（bias は無い） */
  function lnInto(src, dst, n, d, g, eps) {
    for (var t = 0; t < n; t++) {
      var o = t * d, m = 0.0, v = 0.0, k;
      for (k = 0; k < d; k++) m += src[o + k];
      m /= d;
      for (k = 0; k < d; k++) { var z = src[o + k] - m; v += z * z; }
      v = 1.0 / Math.sqrt(v / d + eps);
      for (k = 0; k < d; k++) dst[o + k] = (src[o + k] - m) * v * g[k];
    }
  }

  function gelu(x) {
    return 0.5 * x * (1.0 + Math.tanh(0.7978845608028654 * (x + 0.044715 * x * x * x)));
  }

  function Encoder(buf) {
    var h = parse(buf);
    this.T = h.T;
    this.cfg = h.config;
    this.nL = h.n_layers;
    this.pool = h.layers;                 // [5, 8]
    this.d = this.cfg.hidden;
    this.h = this.cfg.heads;
    this.hd = this.d / this.h;
    this.vocab = h.vocab_size;
    this.embBits = h.emb_bits || 8;
    this._rope = {};
  }

  /* 位置ごとの cos/sin（長さと theta ごとに使い回す） */
  Encoder.prototype._rt = function (n, theta) {
    var key = n + ':' + theta;
    if (this._rope[key]) return this._rope[key];
    var half = this.hd / 2, cos = new Float32Array(n * half), sin = new Float32Array(n * half);
    for (var i = 0; i < half; i++) {
      var inv = 1.0 / Math.pow(theta, (i * 2.0) / this.hd);
      for (var p = 0; p < n; p++) { var a = p * inv; cos[p * half + i] = Math.cos(a); sin[p * half + i] = Math.sin(a); }
    }
    var r = { cos: cos, sin: sin, half: half };
    this._rope[key] = r;
    return r;
  };

  /* Q または K を head ごとに回転。A は [h][n][hd] を平坦化したもの */
  Encoder.prototype._rope1 = function (A, n, theta) {
    var rt = this._rt(n, theta), half = rt.half, hd = this.hd;
    for (var hh = 0; hh < this.h; hh++) {
      for (var p = 0; p < n; p++) {
        var o = (hh * n + p) * hd, c = p * half;
        for (var i = 0; i < half; i++) {
          var a = A[o + i], b = A[o + half + i], co = rt.cos[c + i], si = rt.sin[c + i];
          A[o + i] = a * co - b * si;
          A[o + half + i] = a * si + b * co;
        }
      }
    }
  };

  /* ids（<s>…</s> 込み）→ 層5と層8の平均プーリングを連結し L2正規化した 512次元 */
  Encoder.prototype.embed = function (ids) {
    var T = this.T, d = this.d, hd = this.hd, nh = this.h, eps = this.cfg.eps;
    var n = ids.length;
    if (n > this.cfg.maxlen) { ids = ids.slice(0, this.cfg.maxlen); n = ids.length; }
    while (n < 3) { ids = ids.concat([this.cfg.pad_id]); n = ids.length; }

    var x = new Float32Array(n * d), r = new Float32Array(n * d);
    if (this.embBits === 4) {
      var hb = d >> 1;
      for (var t = 0; t < n; t++) {
        var id = ids[t], off = id * hb, s = T['emb.s'][id];
        for (var k = 0; k < hb; k++) {
          var by = T['emb'][off + k];
          x[t * d + 2 * k] = ((by & 15) - 8) * s;
          x[t * d + 2 * k + 1] = ((by >> 4) - 8) * s;
        }
      }
    } else {
      for (var t3 = 0; t3 < n; t3++) {
        var id3 = ids[t3], off3 = id3 * d, s3 = T['emb.s'][id3];
        for (var k3 = 0; k3 < d; k3++) x[t3 * d + k3] = T['emb'][off3 + k3] * s3;
      }
    }
    lnInto(x, r, n, d, T['emb_norm'], eps);
    x.set(r);

    var qkv = new Float32Array(n * 3 * d);
    var ctx = new Float32Array(n * d), tmp = new Float32Array(n * d);
    var wi = new Float32Array(n * 2 * (d * 4 / 2 * 2 / 2));  // 実サイズは下で確定
    var dff = T['l0.wi'].length / d;                          // 2048
    wi = new Float32Array(n * dff);
    var act = new Float32Array(n * (dff / 2));
    var Q = new Float32Array(nh * n * hd), K = new Float32Array(nh * n * hd), V = new Float32Array(nh * n * hd);
    var sc = new Float32Array(n), out = [];
    var w2 = this.cfg.local_window / 2, inv = 1.0 / Math.sqrt(hd);

    for (var L = 0; L < this.nL; L++) {
      var p = 'l' + L + '.';
      if (L === 0) r.set(x); else lnInto(x, r, n, d, T[p + 'an'], eps);
      mmI8(r, n, d, T[p + 'qkv'], T[p + 'qkv.s'], 3 * d, qkv);
      /* qkv は [n][3][h][hd] の順。head ごとに [h][n][hd] へ並べ替える */
      for (var t2 = 0; t2 < n; t2++) {
        for (var hh = 0; hh < nh; hh++) {
          var src = t2 * 3 * d + hh * hd, dst = (hh * n + t2) * hd;
          for (var k2 = 0; k2 < hd; k2++) {
            Q[dst + k2] = qkv[src + k2];
            K[dst + k2] = qkv[src + d + k2];
            V[dst + k2] = qkv[src + 2 * d + k2];
          }
        }
      }
      var glob = (L % this.cfg.global_every === 0);
      var th = glob ? this.cfg.theta_g : this.cfg.theta_l;
      this._rope1(Q, n, th); this._rope1(K, n, th);

      for (var hh2 = 0; hh2 < nh; hh2++) {
        var hb = hh2 * n * hd;
        for (var i2 = 0; i2 < n; i2++) {
          var qo = hb + i2 * hd, mx = -Infinity, j;
          var lo = glob ? 0 : Math.max(0, i2 - w2), hi = glob ? n - 1 : Math.min(n - 1, i2 + w2);
          for (j = lo; j <= hi; j++) {
            var ko = hb + j * hd, a = 0.0;
            for (var k3 = 0; k3 < hd; k3++) a += Q[qo + k3] * K[ko + k3];
            a *= inv; sc[j] = a; if (a > mx) mx = a;
          }
          var sum = 0.0;
          for (j = lo; j <= hi; j++) { sc[j] = Math.exp(sc[j] - mx); sum += sc[j]; }
          var co = i2 * d + hh2 * hd;
          for (var k4 = 0; k4 < hd; k4++) ctx[co + k4] = 0;
          for (j = lo; j <= hi; j++) {
            var wgt = sc[j] / sum, vo = hb + j * hd;
            for (var k5 = 0; k5 < hd; k5++) ctx[co + k5] += wgt * V[vo + k5];
          }
        }
      }
      mmI8(ctx, n, d, T[p + 'ao'], T[p + 'ao.s'], d, tmp);
      for (var q1 = 0; q1 < n * d; q1++) x[q1] += tmp[q1];

      lnInto(x, r, n, d, T[p + 'mn'], eps);
      mmI8(r, n, d, T[p + 'wi'], T[p + 'wi.s'], dff, wi);
      var half = dff / 2;
      for (var t3 = 0; t3 < n; t3++) {
        var wo2 = t3 * dff, ao2 = t3 * half;
        for (var k6 = 0; k6 < half; k6++) act[ao2 + k6] = gelu(wi[wo2 + k6]) * wi[wo2 + half + k6];
      }
      mmI8(act, n, half, T[p + 'wo'], T[p + 'wo.s'], d, tmp);
      for (var q2 = 0; q2 < n * d; q2++) x[q2] += tmp[q2];

      if (this.pool.indexOf(L) >= 0) {
        var lo2 = n > 2 ? 1 : 0, hi2 = n > 2 ? n - 1 : n, cnt = hi2 - lo2;
        var m = new Float32Array(d);
        for (var t4 = lo2; t4 < hi2; t4++) for (var k7 = 0; k7 < d; k7++) m[k7] += x[t4 * d + k7];
        for (var k8 = 0; k8 < d; k8++) m[k8] /= cnt;
        out.push(m);
      }
    }
    var vec = new Float64Array(out.length * d), o2 = 0;
    for (var a2 = 0; a2 < out.length; a2++) for (var k9 = 0; k9 < d; k9++) vec[o2++] = out[a2][k9];
    var nrm = 0;
    for (var k10 = 0; k10 < vec.length; k10++) nrm += vec[k10] * vec[k10];
    nrm = Math.sqrt(nrm) + 1e-9;
    for (var k11 = 0; k11 < vec.length; k11++) vec[k11] /= nrm;
    return vec;
  };

  return { Encoder: Encoder };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiEncoder;
