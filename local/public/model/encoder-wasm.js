/* ModernBERT-ja エンコーダの推論（WebAssembly SIMD 版）
 *
 * 計算内容は encoder.js（素のJS版）と同一で、行列積・LayerNorm・注意だけを
 * kernel.wasm に移してある。素のJS版は SIMD が使えない環境向けに残す。
 *
 * 重みも作業領域も、JS側が作った1つの WebAssembly.Memory の中だけに置く。
 * wasm 側は import した memory 以外に触れる手段を持たない（システムコールも無い）。
 */
var SeisekiEncoderWasm = (function () {
  'use strict';

  var PAGE = 65536;
  function align16(x) { return (x + 15) & ~15; }

  function parseHeader(buf) {
    var u8 = new Uint8Array(buf);
    if (!(u8[0] === 83 && u8[1] === 69 && u8[2] === 73 && u8[3] === 83)) throw new Error('形式が違います');
    var dv = new DataView(buf);
    var hlen = dv.getUint32(4, true);
    var hdr = JSON.parse(new TextDecoder('utf-8').decode(u8.subarray(8, 8 + hlen)));
    hdr._base = 8 + hlen;
    return hdr;
  }

  /* weightsBuf: encoder-int8.bin の ArrayBuffer / wasmBuf: kernel.wasm の ArrayBuffer */
  function create(weightsBuf, wasmBuf) {
    var hdr = parseHeader(weightsBuf);
    var cfg = hdr.config, d = cfg.hidden, nh = cfg.heads, hd = d / nh;
    var N = cfg.maxlen;

    /* 1) 配置を決める */
    var off = 64, place = {};
    var names = Object.keys(hdr.tensors);
    for (var i = 0; i < names.length; i++) {
      var m = hdr.tensors[names[i]];
      place[names[i]] = off;
      off = align16(off + m.len);
    }
    var dff = hdr.tensors['l0.wi'].shape[0];            // 2048
    var half = dff / 2;
    var buf = {};
    function alloc(name, floats) { buf[name] = off; off = align16(off + floats * 4); }
    alloc('x', N * d); alloc('r', N * d); alloc('tmp', N * d); alloc('ctx', N * d);
    alloc('qkv', N * 3 * d); alloc('Q', nh * N * hd); alloc('K', nh * N * hd); alloc('V', nh * N * hd);
    alloc('wi', N * dff); alloc('act', N * half); alloc('sbuf', N);
    var pages = Math.ceil((off + PAGE) / PAGE);

    /* 2) メモリを作って wasm を立ち上げ、重みを流し込む */
    var mem = new WebAssembly.Memory({ initial: pages });
    var mod = new WebAssembly.Module(wasmBuf);
    var inst = new WebAssembly.Instance(mod, { env: { memory: mem } });
    var K_ = inst.exports;
    var HEAP8 = new Int8Array(mem.buffer), HEAPF = new Float32Array(mem.buffer);
    var HEAPU8 = new Uint8Array(mem.buffer);
    var src = new Uint8Array(weightsBuf);
    for (var j = 0; j < names.length; j++) {
      var mm = hdr.tensors[names[j]];
      new Uint8Array(mem.buffer, place[names[j]], mm.len)
        .set(src.subarray(hdr._base + mm.off, hdr._base + mm.off + mm.len));
    }

    var E = {};
    E.cfg = cfg; E.vocab = hdr.vocab_size; E.nL = hdr.n_layers; E.pool = hdr.layers;
    E.embBits = hdr.emb_bits || 8;
    E.dim = d * hdr.layers.length;
    E.bytes = off;
    var rope = {};

    function ropeTable(n, theta) {
      var key = n + ':' + theta;
      if (rope[key]) return rope[key];
      var h2 = hd / 2, cos = new Float32Array(n * h2), sin = new Float32Array(n * h2);
      for (var i2 = 0; i2 < h2; i2++) {
        var iv = 1.0 / Math.pow(theta, (i2 * 2.0) / hd);
        for (var p = 0; p < n; p++) { var a = p * iv; cos[p * h2 + i2] = Math.cos(a); sin[p * h2 + i2] = Math.sin(a); }
      }
      rope[key] = { cos: cos, sin: sin, half: h2 };
      return rope[key];
    }

    function applyRope(base, n, theta) {
      var rt = ropeTable(n, theta), h2 = rt.half;
      for (var h = 0; h < nh; h++) {
        for (var p = 0; p < n; p++) {
          var o = (base >> 2) + (h * n + p) * hd, c = p * h2;
          for (var i3 = 0; i3 < h2; i3++) {
            var a = HEAPF[o + i3], b = HEAPF[o + h2 + i3], co = rt.cos[c + i3], si = rt.sin[c + i3];
            HEAPF[o + i3] = a * co - b * si;
            HEAPF[o + h2 + i3] = a * si + b * co;
          }
        }
      }
    }

    /* ids → 層5と層8の平均プーリングを連結し L2正規化した 512次元 */
    E.embed = function (ids) {
      var n = ids.length;
      if (n > N) { ids = ids.slice(0, N); n = N; }
      while (n < 3) { ids = ids.concat([cfg.pad_id]); n = ids.length; }
      var embOff = place['emb'], embS = place['emb.s'] >> 2, xo = buf['x'] >> 2;
      if (E.embBits === 4) {
        /* 1バイトに2つ詰めてある。下位ニブルが偶数次元、値は +8 して格納されている。 */
        var hb = d >> 1;
        for (var t = 0; t < n; t++) {
          var id = ids[t], o = embOff + id * hb, s = HEAPF[embS + id], w2 = xo + t * d;
          for (var k = 0; k < hb; k++) {
            var by = HEAPU8[o + k];
            HEAPF[w2 + 2 * k] = ((by & 15) - 8) * s;
            HEAPF[w2 + 2 * k + 1] = ((by >> 4) - 8) * s;
          }
        }
      } else {
        for (var t2 = 0; t2 < n; t2++) {
          var id2 = ids[t2], o2 = embOff + id2 * d, s2 = HEAPF[embS + id2];
          for (var k2 = 0; k2 < d; k2++) HEAPF[xo + t2 * d + k2] = HEAP8[o2 + k2] * s2;
        }
      }
      K_.layer_norm(buf['x'], buf['r'], n, d, place['emb_norm'], cfg.eps);
      HEAPF.copyWithin(xo, buf['r'] >> 2, (buf['r'] >> 2) + n * d);

      var out = [];
      for (var L = 0; L < E.nL; L++) {
        var p = 'l' + L + '.';
        if (L === 0) HEAPF.copyWithin(buf['r'] >> 2, xo, xo + n * d);
        else K_.layer_norm(buf['x'], buf['r'], n, d, place[p + 'an'], cfg.eps);
        K_.mm_i8(buf['r'], n, d, place[p + 'qkv'], place[p + 'qkv.s'], 3 * d, buf['qkv']);
        var qb = buf['qkv'] >> 2, Qb = buf['Q'] >> 2, Kb = buf['K'] >> 2, Vb = buf['V'] >> 2;
        for (var t2 = 0; t2 < n; t2++) {
          for (var h = 0; h < nh; h++) {
            var s0 = qb + t2 * 3 * d + h * hd, dst = (h * n + t2) * hd;
            for (var k2 = 0; k2 < hd; k2++) {
              HEAPF[Qb + dst + k2] = HEAPF[s0 + k2];
              HEAPF[Kb + dst + k2] = HEAPF[s0 + d + k2];
              HEAPF[Vb + dst + k2] = HEAPF[s0 + 2 * d + k2];
            }
          }
        }
        var glob = (L % cfg.global_every === 0) ? 1 : 0;
        var th = glob ? cfg.theta_g : cfg.theta_l;
        applyRope(buf['Q'], n, th); applyRope(buf['K'], n, th);
        K_.attention(buf['Q'], buf['K'], buf['V'], buf['ctx'], buf['sbuf'],
                     n, nh, hd, glob, cfg.local_window / 2);
        K_.mm_i8(buf['ctx'], n, d, place[p + 'ao'], place[p + 'ao.s'], d, buf['tmp']);
        K_.add_into(buf['x'], buf['tmp'], n * d);
        K_.layer_norm(buf['x'], buf['r'], n, d, place[p + 'mn'], cfg.eps);
        K_.mm_i8(buf['r'], n, d, place[p + 'wi'], place[p + 'wi.s'], dff, buf['wi']);
        K_.geglu(buf['wi'], buf['act'], n, dff);
        K_.mm_i8(buf['act'], n, half, place[p + 'wo'], place[p + 'wo.s'], d, buf['tmp']);
        K_.add_into(buf['x'], buf['tmp'], n * d);
        if (E.pool.indexOf(L) >= 0) {
          var lo = n > 2 ? 1 : 0, hi = n > 2 ? n - 1 : n, cnt = hi - lo;
          var m2 = new Float64Array(d);
          for (var t3 = lo; t3 < hi; t3++) for (var k3 = 0; k3 < d; k3++) m2[k3] += HEAPF[xo + t3 * d + k3];
          for (var k4 = 0; k4 < d; k4++) m2[k4] /= cnt;
          out.push(m2);
        }
      }
      var vec = new Float64Array(out.length * d), w = 0;
      for (var a2 = 0; a2 < out.length; a2++) for (var k5 = 0; k5 < d; k5++) vec[w++] = out[a2][k5];
      var nr = 0;
      for (var k6 = 0; k6 < vec.length; k6++) nr += vec[k6] * vec[k6];
      nr = Math.sqrt(nr) + 1e-9;
      for (var k7 = 0; k7 < vec.length; k7++) vec[k7] /= nr;
      return vec;
    };
    return E;
  }

  return { create: create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiEncoderWasm;
