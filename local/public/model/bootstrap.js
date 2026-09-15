/* 声析 ローカル判定 — 起動の入口
 *
 * アプリ側はこの1本だけ呼べばよい。
 *   受け取り（初回だけ）→ 保管 → 別レーンへ読み込み → 判定できる状態
 *
 *   var boot = SeisekiBootstrap.create({
 *     manifestUrl: '/model/manifest.json',
 *     workerUrl:   '/model/worker.js',
 *     onState:     function (s) { ... 'none'|'downloading'|'loading'|'ready'|'failed' ... },
 *     onProgress:  function (done, total) { ... 受け取りの進み具合 ... },
 *     onError:     function (e) { ... e.message はそのまま画面に出せる文 ... }
 *   });
 *
 *   boot.begin();          // 初回ログイン直後に呼ぶ。裏で受け取る。操作は止まらない
 *   boot.cancel();         // 受け取りをやめる
 *   boot.retry();          // 失敗したあと、もう一度
 *   boot.ready();          // Promise<判定できる窓口>。まだなら受け取りから始める
 *   boot.remove();         // 端末から消す
 *
 * 画面に出すもの:
 *   state==='downloading' … 進捗バー ＋「オフライン用データを受信中 12.4 / 20.4 MB」
 *   state==='ready'       … 「オフラインでも判定できるようになりました」
 *   state==='failed'      … onError の文 ＋［再開］
 */
var SeisekiBootstrap = (function () {
  'use strict';

  function create(opt) {
    var st = {
      state: 'none', store: null, client: null, job: null,
      man: null, err: null, readyP: null
    };

    function setState(s) {
      st.state = s;
      if (opt.onState) opt.onState(s, st);
    }

    function loadManifest() {
      if (st.man) return Promise.resolve(st.man);
      return fetch(opt.manifestUrl, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw { code: 'http', status: r.status };
        return r.json();
      }).then(function (m) {
        st.man = m;
        st.store = new SeisekiModelStore(m, opt.storeOpt);
        return m;
      });
    }

    function toClient() {
      setState('loading');
      var keys = st.man.files.map(function (f) { return f.key; });
      return Promise.all(keys.map(function (k) { return st.store.get(k); }))
        .then(function (bufs) {
          var src = {};
          keys.forEach(function (k, i) { src[k] = bufs[i]; });
          st.client = new SeisekiLocalClient(opt.workerUrl);
          return st.client.load(src);
        }).then(function (info) {
          setState('ready');
          return st.client;
        });
    }

    function run() {
      st.err = null;
      return loadManifest().then(function () {
        return st.store.status();
      }).then(function (s) {
        if (s.state === 'ready') return toClient();
        setState('downloading');
        if (opt.onProgress) opt.onProgress(s.have, s.total);
        st.job = st.store.ensure({ onProgress: opt.onProgress });
        return st.job.then(function () { return toClient(); });
      }).catch(function (e) {
        var code = (e && e.code) || 'unknown';
        st.err = { code: code, message: SeisekiModelStore.messageFor({ code: code }), raw: e };
        if (code === 'aborted') { setState('none'); }
        else { setState('failed'); if (opt.onError) opt.onError(st.err); }
        throw st.err;
      });
    }

    return {
      get state() { return st.state; },
      get error() { return st.err; },
      /* 初回ログイン直後に呼ぶ。失敗しても投げない（画面を壊さない） */
      begin: function () {
        if (!st.readyP) st.readyP = run().catch(function () { return null; });
        return st.readyP;
      },
      /* 判定したいときに呼ぶ。まだなら受け取りから始める */
      ready: function () {
        if (!st.readyP || st.state === 'failed') st.readyP = run();
        return st.readyP;
      },
      retry: function () { st.readyP = null; return this.ready(); },
      cancel: function () { if (st.job) st.job.cancel(); },
      status: function () {
        return st.store ? st.store.status()
                        : loadManifest().then(function () { return st.store.status(); });
      },
      remove: function () {
        st.readyP = null;
        if (st.client) { st.client.close(); st.client = null; }
        setState('none');
        return st.store ? st.store.remove()
                        : loadManifest().then(function () { return st.store.remove(); });
      },
      client: function () { return st.client; }
    };
  }

  return { create: create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiBootstrap;
