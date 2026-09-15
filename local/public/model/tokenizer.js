/* SentencePiece Unigram トークナイザ（声析・ローカル判定用）
 *
 * sbintuitions/modernbert-ja の tokenizer.json と同じ結果を返す。
 * Rust版(tokenizers) → 自作Python版 → 本ファイル、の順に全1,547件で一致を確認している。
 *
 * 仕様（tokenizer.json から読み取ったもの・推測なし）
 *   正規化      なし
 *   前処理      半角スペースを ▁ に置換するだけ（分割も前置もしない）
 *   本体        Unigram / unk_id=0 / byte_fallback あり
 *   後処理      <s> ... </s> を前後に付ける
 *
 * Viterbi は sentencepiece と同じ手続き:
 *   ・1文字ずつ前へ進み、その位置から始まる語彙をすべて候補にする
 *   ・1文字ぶんの候補が1つも無い位置には unk（最小スコア − 10.0）を置く
 *   ・最後に終端から逆にたどる
 */
var SeisekiTokenizer = (function () {
  'use strict';

  var UNK_PENALTY = 10.0;

  function b64ToInt16(b64) {
    var bin;
    if (typeof atob === 'function') {
      bin = atob(b64);
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Int16Array(u8.buffer);
    }
    var buf = Buffer.from(b64, 'base64');           // Node 側
    return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  }

  /* data = tok-data.json の中身 */
  function Tokenizer(data) {
    this.vocab = data.v.split('\n');
    var q = b64ToInt16(data.s);
    this.score = new Float64Array(q.length);
    var min = 0;
    for (var i = 0; i < q.length; i++) {
      this.score[i] = q[i] / 1000;
      if (this.score[i] < min) min = this.score[i];
    }
    this.minScore = min;
    this.rep = data.rep;
    this.bos = data.bos;
    this.eos = data.eos;
    this.unk = data.unk;

    this.id = new Map();
    this.maxLen = 1;
    for (var k = 0; k < this.vocab.length; k++) {
      var t = this.vocab[k];
      if (!this.id.has(t)) this.id.set(t, k);
      var n = 0, j = 0;
      while (j < t.length) { n++; j += (t.codePointAt(j) > 0xFFFF ? 2 : 1); }
      if (n > this.maxLen) this.maxLen = n;
    }
    this.byteId = new Int32Array(256);
    var HEX = '0123456789ABCDEF';
    for (var b = 0; b < 256; b++) {
      var name = '<0x' + HEX[b >> 4] + HEX[b & 15] + '>';
      var v = this.id.has(name) ? this.id.get(name) : -1;
      this.byteId[b] = v;
    }
    this.enc = (typeof TextEncoder === 'function') ? new TextEncoder() : null;
  }

  /* 文字列 → UTF-8 バイト列（TextEncoder が無い環境向けの手書き経路も持つ） */
  Tokenizer.prototype._bytes = function (s) {
    if (this.enc) return this.enc.encode(s);
    var out = [], i = 0;
    while (i < s.length) {
      var c = s.codePointAt(i);
      i += (c > 0xFFFF ? 2 : 1);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  };

  /* Viterbi。文字（コードポイント）単位で持つ。バイト単位の実装と結果は同一。 */
  Tokenizer.prototype._viterbi = function (chars) {
    var n = chars.length;
    var score = new Float64Array(n + 1);
    var start = new Int32Array(n + 1).fill(-1);
    var unkScore = this.minScore - UNK_PENALTY;
    var i, j, hi, piece, idx, cand;
    for (i = 0; i < n; i++) {
      if (i > 0 && start[i] < 0) continue;          /* 到達不能な位置は無い（1文字ずつ必ず張る） */
      var here = score[i];
      var hasSingle = false;
      hi = Math.min(n, i + this.maxLen);
      piece = '';
      for (j = i + 1; j <= hi; j++) {
        piece += chars[j - 1];
        idx = this.id.get(piece);
        if (idx !== undefined) {
          cand = this.score[idx] + here;
          if (start[j] < 0 || cand > score[j]) { score[j] = cand; start[j] = i; }
          if (j - i === 1) hasSingle = true;
        }
      }
      if (!hasSingle) {
        j = i + 1;
        cand = unkScore + here;
        if (start[j] < 0 || cand > score[j]) { score[j] = cand; start[j] = i; }
      }
    }
    var out = [];
    j = n;
    while (j > 0) { i = start[j]; out.push(chars.slice(i, j).join('')); j = i; }
    out.reverse();
    return out;
  };

  /* 文字列 → トークンID列（<s> と </s> を含む） */
  Tokenizer.prototype.encode = function (text, addSpecial) {
    var s = String(text == null ? '' : text).split(' ').join(this.rep);
    var ids = [];
    if (s.length) {
      var chars = Array.from(s);
      var pieces = this._viterbi(chars);
      for (var k = 0; k < pieces.length; k++) {
        var idx = this.id.get(pieces[k]);
        if (idx !== undefined && idx !== this.unk) { ids.push(idx); continue; }
        var bs = this._bytes(pieces[k]), ok = [];
        for (var b = 0; b < bs.length; b++) {
          if (this.byteId[bs[b]] < 0) { ok = null; break; }
          ok.push(this.byteId[bs[b]]);
        }
        if (ok) { for (var m = 0; m < ok.length; m++) ids.push(ok[m]); }
        else ids.push(this.unk);
      }
    }
    if (addSpecial === false) return ids;
    return [this.bos].concat(ids, [this.eos]);
  };

  Tokenizer.prototype.decode = function (ids) {
    var s = '';
    for (var i = 0; i < ids.length; i++) {
      var t = this.vocab[ids[i]];
      if (t === '<s>' || t === '</s>' || t === '<pad>') continue;
      s += t;
    }
    return s.split(this.rep).join(' ');
  };

  return { Tokenizer: Tokenizer };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiTokenizer;
