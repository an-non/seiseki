/* 声析 ローカル判定（第2段）
 *
 *   文 → トークナイザ → エンコーダ(int8/WASM) → 512次元 → 線形ヘッド
 *        → { params: { emo: { pol }, valid, crit, motiv }, cat }
 *
 * API（第1段）が使えないときの代替。API と同じ形の値を返すが、
 * chunks / tt / tn は出せない（下の analyze の戻り値に含めない）。
 */
var SeisekiLocal = (function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function dot(vec, coef) {
    var s = coef[vec.length];                 /* 最後の1つがバイアス */
    for (var i = 0; i < vec.length; i++) s += vec[i] * coef[i];
    return s;
  }

  /* tok: SeisekiTokenizer.Tokenizer / enc: encoder-wasm の create() 戻り値
     head: head-*-full.json（線形）または head-krr.js の load() 戻り値（カーネル） */
  function Local(tok, enc, head) {
    this.tok = tok; this.enc = enc; this.head = head;
    this.kernel = !!head.hdr;                 /* カーネル版か */
    var d = this.kernel ? head.dim : head.dim;
    if (d !== enc.dim) throw new Error('ヘッドとエンコーダの次元が合いません');
  }

  /* 7帯。Python 側の band() と等価（境界の <= と < の混在まで含めて合わせてある） */
  function bandOf(p) {
    if (p <= -0.68) return 0;
    if (p <= -0.35) return 1;
    if (p <= -0.12) return 2;
    if (p < 0.08) return 3;
    if (p < 0.28) return 4;
    if (p < 0.58) return 5;
    return 6;
  }

  Local.prototype.vector = function (text) {
    return this.enc.embed(this.tok.encode(text));
  };

  Local.prototype.analyze = function (text) {
    return this.kernel ? this.analyzeKernel(this.vector(text))
                       : this.analyzeLinear(this.vector(text));
  };

  /* --- カーネル版 --- */
  Local.prototype.analyzeKernel = function (v) {
    var H = this.head, o = H.score(v), cats = H.hdr.cats;
    var pol = clamp(o.pol, -1, 1);
    var best = 0;
    for (var i = 0; i < cats.length; i++) if (o.cat[i] > o.cat[best]) best = i;
    /* 7帯: 分類スコアと回帰の合議（重みは学習時に dev で決めた値） */
    var w = H.hdr.band_w, mx = 0;
    for (var b = 0; b < 7; b++) mx = Math.max(mx, Math.abs(o.band[b]));
    var bv = bandOf(pol), bb = 0, bs = -Infinity;
    for (b = 0; b < 7; b++) {
      var s2 = o.band[b] / (mx + 1e-9) * w + (-Math.abs(b - bv)) / 6 * (1 - w);
      if (s2 > bs) { bs = s2; bb = b; }
    }
    var tt = null;
    if (o.tt && H.hdr.tts) {
      var bt = 0;
      for (var j = 0; j < o.tt.length; j++) if (o.tt[j] > o.tt[bt]) bt = j;
      tt = H.hdr.tts[bt];
    }
    return {
      params: {
        emo: { pol: pol, band: bb },
        valid: Math.round(clamp(o.valid, 0, 1) * 100),
        crit: Math.round(clamp(o.crit, 0, 1) * 100),
        motiv: Math.round(clamp(o.motiv, 0, 1) * 100)
      },
      ideology: { econ: Math.round(clamp(o.econ, -1, 1) * 100),
                  soc: Math.round(clamp(o.soc, -1, 1) * 100) },
      cat: cats[best],
      tt: tt,
      src: 'local'
    };
  };

  /* --- 線形版（従来） --- */
  Local.prototype.analyzeLinear = function (v) {
    var H = this.head;
    var cats = H.cats, best = 0, bestS = -Infinity;
    for (var i = 0; i < cats.length; i++) {
      var s = dot(v, H.cat[cats[i]]);
      if (s > bestS) { bestS = s; best = i; }
    }
    var r = {
      params: {
        emo: { pol: clamp(dot(v, H.pol), -1, 1) },
        valid: Math.round(clamp(dot(v, H.valid), 0, 1) * 100),
        crit: Math.round(clamp(dot(v, H.crit), 0, 1) * 100),
        motiv: Math.round(clamp(dot(v, H.motiv), 0, 1) * 100)
      },
      cat: cats[best],
      src: 'local'
    };
    /* econ / soc は統一ラベル版のヘッドにだけ入っている。無い版では出さない */
    if (H.econ && H.soc) {
      r.ideology = {
        econ: Math.round(clamp(dot(v, H.econ), -1, 1) * 100),
        soc: Math.round(clamp(dot(v, H.soc), -1, 1) * 100)
      };
    }
    return r;
  };

  /* 複数件。1件ごとに進捗を返せるようにしてある（UIを止めないため） */
  Local.prototype.analyzeAll = function (texts, onProgress) {
    var out = [];
    for (var i = 0; i < texts.length; i++) {
      out.push(this.analyze(texts[i]));
      if (onProgress) onProgress(i + 1, texts.length);
    }
    return out;
  };

  /* アプリの sanitizeAnalysis がそのまま受け取れる形にして返す。
     出せない項目は、出せないと分かる形で埋める（後述の CAP を参照）。 */
  Local.prototype.analyzeResponse = function (freeText, chunkLib, maxChunks, defaultTarget) {
    var C = chunkLib, text = String(freeText == null ? '' : freeText);
    /* defaultTarget = {tt:'地方自治体', tn:'品川区'} のように、調査そのものの対象を渡せる。
       住民アンケートでは自分の自治体名を書かないことが多く、規則では拾えないため。 */
    var whole = text.trim() ? this.analyze(text) : null;
    var pieces = C.split(text, maxChunks || 5);
    var chunks = [];
    for (var i = 0; i < pieces.length; i++) {
      var a = this.analyze(pieces[i]);
      var tg = C.findTarget(pieces[i]);
      if (tg.tt === 'その他' && defaultTarget) tg = defaultTarget;
      /* tt は学習値のほうが当たる（規則 55.6% → 学習 69.3%）。
         tn（具体名）は本文からしか取れないので規則のまま */
      if (a.tt) tg = { tt: a.tt, tn: tg.tn || (defaultTarget ? defaultTarget.tn : '') };
      chunks.push({
        s: pieces[i].slice(0, 25),                 /* 要約は作れないので冒頭25字 */
        cat: a.cat,
        topic: C.findTopic(pieces[i], tg.tn),
        tt: tg.tt,
        tn: tg.tn,
        emo: a.params.emo.pol,
        crit: a.params.crit,
        fact: C.factOf(pieces[i], a.cat)
      });
    }
    var attrs = whole ? C.allTopics(text, 4, '') : [];
    return {
      params: {
        emo: {
          pol: whole ? whole.params.emo.pol : 0,
          label: whole ? C.emoLabel(whole.params.emo.pol, whole.cat) : '中立',
          /* カーネル版だけ、7帯を分類として直接出す（回帰から切るより一致率が高い） */
          band: (whole && whole.params.emo.band != null) ? whole.params.emo.band : null
        },
        valid: whole ? whole.params.valid : 50,
        crit: whole ? whole.params.crit : 40,
        motiv: whole ? whole.params.motiv : 40
      },
      /* econ は統一ラベル版のヘッドがあるときだけ学習値。soc は非ゼロの教師が少なく
         相関 0.24 しか出ていないので、学習値としては返さず 0 のままにする */
      ideology: (whole && whole.ideology) ? { econ: whole.ideology.econ, soc: 0 }
                                          : { econ: 0, soc: 0 },
      attrs: attrs,
      chunks: chunks,
      ai: false,
      src: 'local',
      /* どの項目が測って出した値で、どれが規則・既定値かを呼び出し側に伝える */
      cap: (whole && whole.ideology)
        ? { learned: ['pol', 'band', 'valid', 'crit', 'motiv', 'cat', 'tt', 'ideology.econ'],
            rule: ['s', 'topic', 'tn', 'fact', 'label', 'attrs'],
            none: ['ideology.soc'] }
        : { learned: ['pol', 'valid', 'crit', 'motiv', 'cat'],
            rule: ['s', 'topic', 'tt', 'tn', 'fact', 'label', 'attrs'],
            none: ['ideology.econ', 'ideology.soc'] }
    };
  };

  return { Local: Local };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiLocal;
