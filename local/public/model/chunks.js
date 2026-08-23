/* 意見単位への分割と、対象・トピックの推定（規則ベース）
 *
 * ここは「学習で出せない項目」の穴埋め。API（第1段）は chunks の s / topic / tt / tn を
 * 生成で出しているが、線形ヘッドでは出せない。分類ヘッドを足そうにも、手元のコーパスの
 * topic 欄は「どの調査票の設問か」であって政策トピックではなく、学習させると
 * 「どの調査から来た文か」を当てるだけになるので使わない。
 *
 * したがってここは規則（辞書＋正規表現）で埋め、規則で決まらなければ "その他" を返す。
 * 精度は測っていない（正解ラベルが無い）。被覆率だけは測れるので報告書に載せる。
 */
var SeisekiChunks = (function () {
  'use strict';

  var TT_TYPES = ['政党', '省庁', '地方自治体', '企業', '団体', '政府全般', 'その他'];

  /* 具体名の辞書。列挙できる閉じた集合だけを載せる */
  var PARTY = ['自由民主党', '自民党', '自民', '立憲民主党', '立憲民主', '立憲', '公明党', '公明',
    '日本維新の会', '維新', '国民民主党', '国民民主', '日本共産党', '共産党', '共産',
    'れいわ新選組', 'れいわ', '社会民主党', '社民党', '社民', '参政党', '日本保守党',
    'みんなでつくる党', '与党', '野党'];
  var MINISTRY = ['財務省', '厚生労働省', '厚労省', '文部科学省', '文科省', '国土交通省', '国交省',
    '経済産業省', '経産省', '農林水産省', '農水省', '環境省', '防衛省', '総務省', '法務省',
    '外務省', 'デジタル庁', 'こども家庭庁', '復興庁', '内閣府', '金融庁', '消費者庁',
    '警察庁', '国税庁', '気象庁', 'スポーツ庁', '文化庁', '特許庁', '中小企業庁',
    '観光庁', '林野庁', '水産庁', '海上保安庁', '公正取引委員会', '会計検査院'];
  var GOV = ['政府', '内閣', '首相', '総理', '官邸', '国会', '衆議院', '参議院', '国', '中央省庁'];
  var ORG = ['労働組合', '労組', '組合', '協会', '連合会', '連合', '学会', 'ＮＰＯ', 'NPO',
    '財団', '社団', '商工会', '自治会', '町内会', 'PTA', 'ＰＴＡ', '医師会', '農協', '生協'];
  /* 自治体は数が多いので正規表現で拾う（1〜5文字＋都道府県市区町村） */
  /* 都道府県は閉じた集合なので列挙する。市区町村より先に取り除かないと
     「東京都八王子市」が「京都八王子市」のように誤って切れる。 */
  var PREF = ('北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 ' +
    '神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 ' +
    '兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 ' +
    '長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県').split(' ');
  /* 接尾辞は市区町村だけにする。都・道・府・県は上の PREF が全部拾うので外す。
     外さないと「歩道」「政府」「他県」「首都」が自治体名として拾われてしまう。 */
  var MUNI_SUF = '市区町村';
  var MUNI_CH = /[一-龥ぁ-んァ-ヶー]/;
  var MUNI_STOP = /[のはをにがともでへやかっ、。！？\s]/;
  /* 「都市」「市町村」のように、自治体名でないのに引っかかる語を弾く */
  var MUNI_NG = {};
  '都市 市町村 町村 市街 市営 区営 町営 村営 地区 学区 校区 区域 区分 管区 街区 選挙区 地方 農村 漁村 山村 町内 町中 下町 城下町 商店街区 市街 全市 全区 全町 全村 各市 各区 各町 各村 当市 当区 本市 本区 他市 他区 同市 同区 この市 この区 その市 その区'
    .split(' ').forEach(function (w) { MUNI_NG[w] = 1; });
  var COMPANY = /(?:株式会社[一-龥ぁ-んァ-ヶA-Za-zＡ-Ｚａ-ｚ0-9]{1,10}|[一-龥ァ-ヶA-Za-z]{2,10}(?:株式会社|\(株\)|（株）))|東京電力|関西電力|中部電力|東京ガス|ＪＲ|JR東日本|JR西日本|JR|ＮＴＴ|NTT|日本郵便|ゆうちょ/;

  /* トピック辞書。API が出す「政策トピックの一般名詞」に寄せた統制語彙 */
  var TOPIC = [
    ['子育て支援', /保育|待機児童|子育て|育児|学童|児童館|産休|育休|子ども医療|幼稚園|こども園/],
    ['教育', /学校|教育|教員|先生|授業|給食|いじめ|不登校|大学|奨学金|部活/],
    ['医療', /病院|医療|診療|医師|看護|救急|ワクチン|感染|健診|検診/],
    ['介護', /介護|ヘルパー|特養|老人ホーム|デイサービス|認知症|要支援|要介護/],
    ['年金', /年金|老後|受給資格|年金受給/],
    ['福祉', /福祉|生活保護|障害|障がい|手当|支援金|給付/],
    ['税制', /税|課税|控除|ふるさと納税|インボイス|確定申告/],
    ['経済・景気', /景気|経済|不況|GDP|成長|投資|株価|中小企業|倒産/],
    ['雇用・労働', /雇用|失業|労働|賃金|給料|残業|職場|就職|求人|正社員|非正規|働き方/],
    ['物価', /物価|値上げ|高騰|インフレ|生活費|光熱費|電気代|ガソリン/],
    ['住宅', /住宅|家賃|住まい|マンション|空き家|団地|住環境|再開発/],
    ['交通', /バス|電車|鉄道|駅|交通|渋滞|信号|横断歩道|自転車|駐輪|駐車|タクシー|コミュニティバス/],
    ['道路・インフラ', /道路|舗装|歩道|橋|トンネル|インフラ|老朽化|上下水道|水道|下水/],
    ['都市計画', /まちづくり|都市計画|区画整理|市街地|景観|開発|再整備/],
    ['環境', /環境|温暖化|CO2|脱炭素|緑化|自然|生態|リサイクル|ごみ|ゴミ|清掃|分別/],
    ['エネルギー', /電力|原発|原子力|再生可能|太陽光|風力|エネルギー|節電/],
    ['防災', /防災|災害|地震|津波|台風|水害|洪水|避難|ハザード/],
    ['治安・防犯', /防犯|治安|犯罪|警察|パトロール|街灯|不審|詐欺/],
    ['防衛', /防衛|自衛隊|安全保障|基地|軍|ミサイル/],
    ['外交', /外交|同盟|国際|条約|大使|中国|韓国|北朝鮮|ロシア|アメリカ|米国/],
    ['農林水産', /農業|農家|漁業|林業|水産|農地|耕作|畜産/],
    ['観光', /観光|旅行|インバウンド|宿泊|名所|イベント|祭り|PR|魅力/],
    ['商工業', /商店|商工|工業|製造|事業所|創業|起業|店舗|商店街/],
    ['行政改革', /行政|窓口|手続|申請|職員|議会|議員|区政|市政|都政|県政|効率化|無駄/],
    ['情報・デジタル', /デジタル|マイナンバー|オンライン|IT|ＩＴ|システム|アプリ|ネット|情報公開/],
    ['文化・スポーツ', /文化|図書館|美術|音楽|スポーツ|体育|公民館|生涯学習/],
    ['人権・多様性', /人権|差別|多様性|ジェンダー|LGBT|外国人|共生|平等/],
    ['少子高齢化', /少子|高齢化|人口減|過疎|移住|定住/],
    ['公園・緑化', /公園|遊具|広場|緑地|花壇|街路樹/],
    ['騒音・公害', /騒音|振動|悪臭|公害|飛行|航路|ルート|うるさ/],
    ['地域コミュニティ', /地域|コミュニティ|近所|交流|ボランティア|自治/]
  ];

  function findTarget(s) {
    var i, m;
    for (i = 0; i < PARTY.length; i++) if (s.indexOf(PARTY[i]) >= 0) return { tt: '政党', tn: PARTY[i] };
    for (i = 0; i < MINISTRY.length; i++) if (s.indexOf(MINISTRY[i]) >= 0) return { tt: '省庁', tn: MINISTRY[i] };
    /* 「都市」「この市の都市」のような誤検出を避けるため、
       接尾辞の位置から前へ最大5文字を見て、助詞を含まない最長の名前を採る */
    var pref = '';
    for (i = 0; i < PREF.length; i++) if (s.indexOf(PREF[i]) >= 0) { pref = PREF[i]; break; }
    var body = pref ? s.split(pref).join('　') : s;      /* 都道府県名を外してから市区町村を探す */
    var best = '';
    for (i = 0; i < body.length; i++) {
      if (MUNI_SUF.indexOf(body.charAt(i)) < 0) continue;
      if (i + 1 < body.length && MUNI_SUF.indexOf(body.charAt(i + 1)) >= 0) continue;  /* 「京都市」の“都”のように連続する場合は末尾だけ見る */
      for (var len = 5; len >= 1; len--) {
        if (i - len < 0) continue;
        var name = body.substr(i - len, len + 1), ok = true;
        for (var c = 0; c < len; c++) {
          var ch = name.charAt(c);
          if (MUNI_STOP.test(ch) || !MUNI_CH.test(ch)) { ok = false; break; }
        }
        if (ok && !MUNI_NG[name] && name.length >= 2) {
          if (name.length >= best.length) best = name;      /* 「東村」より「東村山市」を採る */
          break;
        }
      }
    }
    if (best) return { tt: '地方自治体', tn: best };          /* より具体的な市区町村を優先 */
    if (pref) return { tt: '地方自治体', tn: pref };
    m = COMPANY.exec(s);
    if (m) return { tt: '企業', tn: m[0] };
    for (i = 0; i < ORG.length; i++) if (s.indexOf(ORG[i]) >= 0) return { tt: '団体', tn: ORG[i] };
    for (i = 0; i < GOV.length; i++) if (s.indexOf(GOV[i]) >= 0) return { tt: '政府全般', tn: '' };
    return { tt: 'その他', tn: '' };
  }

  /* 対象名（厚生労働省など）に含まれる語がトピック判定を汚すので、先に取り除く */
  function stripTarget(s, tn) {
    return tn ? s.split(tn).join('') : s;
  }

  function findTopic(s, tn) {
    var t = stripTarget(s, tn);
    for (var i = 0; i < TOPIC.length; i++) if (TOPIC[i][1].test(t)) return TOPIC[i][0];
    return 'その他';
  }

  function allTopics(s, max, tn) {
    var t = stripTarget(s, tn), out = [];
    for (var i = 0; i < TOPIC.length && out.length < max; i++) if (TOPIC[i][1].test(t)) out.push(TOPIC[i][0]);
    return out;
  }

  /* 意見単位に割る。句点・改行で切り、短すぎる断片は前にくっつける。最大 max 件。 */
  function split(text, max) {
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var parts = [], cur = '';
    for (var ci = 0; ci < s.length; ci++) {
      var ch = s.charAt(ci);
      if (ch === '\n') { if (cur) parts.push(cur); cur = ''; continue; }
      cur += ch;
      if ('。！？!?'.indexOf(ch) >= 0) { parts.push(cur); cur = ''; }
    }
    if (cur) parts.push(cur);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      if (out.length && (p.length < 8 || out[out.length - 1].length < 8)) out[out.length - 1] += p;
      else out.push(p);
    }
    if (!out.length) return [];
    if (out.length <= max) return out;
    /* 多すぎるときは長いものを優先して残し、元の順序に戻す */
    var idx = out.map(function (t, i2) { return [t.length, i2]; })
      .sort(function (a, b) { return b[0] - a[0]; }).slice(0, max)
      .map(function (a) { return a[1]; }).sort(function (a, b) { return a - b; });
    return idx.map(function (i3) { return out[i3]; });
  }

  /* 主要感情ラベル（漢字2〜3字）。APIの label 欄の代わり */
  function emoLabel(pol, cat) {
    if (pol <= -0.6) return '憤り';
    if (pol <= -0.3) return '不満';
    if (pol <= -0.1) return '懸念';
    if (pol < 0.1) return '中立';
    if (pol < 0.3) return (cat === '要望' || cat === '提言') ? '期待' : '安心';
    if (pol < 0.6) return '満足';
    return '感謝';
  }

  /* 事実主張で、数値や日付を含むものは「要検証」 */
  var NUM = /[0-9０-９]|[一二三四五六七八九十百千万億]+(?:件|人|円|割|％|%|倍|年|月|日|回)/;
  function factOf(text, cat) {
    if (cat === '事実主張') return '要検証';
    return NUM.test(text) ? '要検証' : '意見';
  }

  return { TT_TYPES: TT_TYPES, split: split, findTarget: findTarget, findTopic: findTopic,
           allTopics: allTopics, emoLabel: emoLabel, factOf: factOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SeisekiChunks;
