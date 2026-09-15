/* ローカルモデル橋渡しの確認。
   確かめること:
     1) 受け取っていないとき、analyze は待たずに規則解析へ落ちる
     2) そのとき、勝手に受け取りを始めない  ← ここが今回の要
     3) resume は「受け取り済み」のときだけ読み込む
     4) resume は「未取得」のときは何もしない
     5) begin を押されたときだけ受け取る
     6) 使えるようになったら analyze はモデルを使い、engine が付く
     7) モデルが例外を投げても規則解析へ落ちる
     8) 自由記述が空ならモデルを呼ばない
     9) 別レーンが黙り込んでも、打ち切って規則解析へ落ちる
*/
'use strict';
const fs = require('fs');
const path = require('path');
const BRIDGE = path.join(__dirname, '..', 'core', 'seiseki-local-bridge.js');
/* 本体は module.exports を持たない（バンドラの警告を避けるため）。
   ここではファイルを読んで評価し、窓口だけ受け取る。 */
function loadBridge(timeoutMs) {
  let src = fs.readFileSync(BRIDGE, 'utf8');
  /* 検査では打ち切りを短くして待たない */
  if (timeoutMs) src = src.replace(/var ANALYZE_TIMEOUT_MS = \d+;/, 'var ANALYZE_TIMEOUT_MS = ' + timeoutMs + ';');
  return new Function(src + '\n;return SeisekiLocalBridge;')();
}

let pass = 0, fail = 0;
function ck(name, ok, note = '') {
  (ok ? pass++ : fail++);
  console.log('  %s %s  %s', ok ? 'OK  ' : 'だめ', String(name).padEnd(46), note);
}

/* ---- 置き場と別レーンの代わり ---- */
function makeWorld(storeState, opt) {
  opt = opt || {};
  const log = { begin: 0, status: 0, load: 0, analyze: 0 };
  let state = 'none';
  const client = {
    analyze: async () => {
      log.analyze++;
      if (opt.hangs) return new Promise(() => {});   /* 永久に返事をしない */
      if (opt.throws) throw new Error('別レーンが落ちた');
      return { params: { emo: { pol: -0.4 } }, chunks: [] };
    }
  };
  global.SeisekiModelStore = function () {};
  global.SeisekiLocalClient = function () {};
  global.SeisekiBootstrap = {
    create(opt) {
      return {
        get state() { return state; },
        begin: async () => { log.begin++; state = 'ready'; if (opt.onState) opt.onState('ready'); return client; },
        ready: async () => { log.load++; return client; },
        status: async () => { log.status++; return { state: storeState, have: 0, total: 100 }; },
        cancel() {}, retry: async () => client, remove: async () => {},
      };
    }
  };
  return { log, B: loadBridge(opt.timeoutMs), setState: (s) => { state = s; } };
}
const RULES = () => ({ engine: 'local-rules-v1', params: {}, chunks: [] });

(async () => {
  console.log('=== ローカルモデル橋渡し ===');

  /* 1) 2) 未取得のときは待たず、受け取りも始めない */
  {
    const { log, B } = makeWorld('none');
    const a = await B.analyze({ free: '税が高い' }, [], RULES);
    ck('1. 未取得なら規則解析へ落ちる', a && a.engine === 'local-rules-v1', 'engine=' + (a && a.engine));
    ck('2. そのとき受け取りを始めない', log.begin === 0 && log.load === 0,
       `begin=${log.begin} / ready=${log.load}`);
  }

  /* 3) 受け取り済みなら resume で読み込む */
  {
    const { log, B } = makeWorld('ready');
    await B.resume();
    ck('3. 受け取り済みなら resume が読み込む', log.begin === 1, `begin=${log.begin}`);
  }

  /* 4) 未取得なら resume は何もしない */
  {
    const { log, B } = makeWorld('none');
    await B.resume();
    ck('4. 未取得なら resume は何もしない', log.begin === 0, `begin=${log.begin}`);
  }

  /* 5) begin を押されたときだけ受け取る */
  {
    const { log, B } = makeWorld('none');
    await B.begin();
    ck('5. begin で受け取りが始まる', log.begin === 1, `begin=${log.begin}`);
  }

  /* 6) 使えるようになったらモデルを使う */
  {
    const { log, B } = makeWorld('ready');
    await B.resume();
    const a = await B.analyze({ free: '税が高い' }, [], RULES);
    ck('6. 使えるならモデルを使う',
       a && a.engine === 'seiseki-local-v1' && a.ai === false && log.analyze === 1,
       'engine=' + (a && a.engine));
  }

  /* 7) モデルが転んでも規則解析へ落ちる */
  {
    const { log, B } = makeWorld('ready', { throws: true });
    await B.resume();
    const a = await B.analyze({ free: '税が高い' }, [], RULES);
    ck('7. モデルが転んでも規則解析へ落ちる',
       a && a.engine === 'local-rules-v1' && log.analyze === 1,
       'engine=' + (a && a.engine) + ' / 呼ばれた回数=' + log.analyze);
  }

  /* 8) 自由記述が空なら、モデルを呼ばずに規則解析へ */
  {
    const { log, B } = makeWorld('ready');
    await B.resume();
    const a = await B.analyze({ free: '   ' }, [], RULES);
    ck('8. 空文はモデルを呼ばない', a && a.engine === 'local-rules-v1' && log.analyze === 0,
       '呼ばれた回数=' + log.analyze);
  }

  /* 9) 黙り込み → 打ち切って規則解析へ */
  {
    const { B } = makeWorld('ready', { hangs: true, timeoutMs: 1500 });
    await B.resume();
    const t0 = Date.now();
    const a = await B.analyze({ free: '税が高い' }, [], RULES);
    const dt = Date.now() - t0;
    ck('9. 黙り込みを打ち切って規則解析へ',
       a && a.engine === 'local-rules-v1' && dt >= 1400 && dt < 6000,
       'engine=' + (a && a.engine) + ' / ' + (dt / 1000).toFixed(1) + '秒で復帰');
  }

  console.log('\n%s  OK %d / だめ %d', fail === 0 ? '✅ 問題なし' : '❌ 不合格', pass, fail);
  process.exit(fail === 0 ? 0 : 1);
})();
