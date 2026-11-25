/**
 * パラメータ定義（UI生成用スキーマ）とプリセットの検証。組み込みプリセットの実体は src/presets/ の JSON。
 * プリセットJSONの形式は Phase 2（音源解析）の出力と共通: { version, instrument, name, source, meter?, params, handStats? }
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const num = (key, label, min, max, step, def, unit, desc) => ({ type: 'number', key, label, min, max, step, default: def, unit: unit || '', desc: desc || '' });
  const bool = (key, label, def, desc) => ({ type: 'bool', key, label, default: def, desc: desc || '' });
  const select = (key, label, options, def, desc) => ({ type: 'select', key, label, options, default: def, desc: desc || '' });
  // 手書きの波形（1周ぶんの点列。値は -1〜1）
  const WAVE_POINTS = 64;
  const roundWave = (v) => Math.round(v * 1000) / 1000;
  const SINE_WAVE = Array.from({ length: WAVE_POINTS }, (_, i) => roundWave(Math.sin((2 * Math.PI * i) / WAVE_POINTS)));
  const wave = (key, label, def, desc) => ({ type: 'wave', key, label, points: WAVE_POINTS, default: def, desc: desc || '' });

  // 拍ごとのずれ（ms）: { 拍数: { at: 各拍の頭のずれ, mid: 各拍の途中の膨らみ（拍頭どうしを結ぶ直線からの差） } }。正=遅らせる（タメ）、負=前がかり
  // 拍数は 1小節の拍数（6/8・12/8 は付点4分を1拍）。値の無い拍数は全拍0
  const BEAT_SHIFT_MAX = 60;
  const MAX_PULSES = 32;
  const beats = (key, label, def, desc) => ({ type: 'beats', key, label, max: BEAT_SHIFT_MAX, maxPulses: MAX_PULSES, swingMin: SWING_MIN, swingMax: SWING_MAX,default: def, desc: desc || '' });
  const clampShift = (v) => Math.round(Math.max(-BEAT_SHIFT_MAX, Math.min(BEAT_SHIFT_MAX, v)));
  // スイング: swing＝裏の位置（%。50＝イーブン、66.7＝三連、75＝付点）、swingGrid＝ハネさせる音価（8分・16分）。値の無いものは 50・8分
  const SWING_MIN = 50;
  const SWING_MAX = 75;
  /** 拍数 n の拍ごとのずれ（値が無ければ全拍0・スイング無し） */
  function beatShiftOf(value, n) {
    const b = (value && value[n]) || { at: Array(n).fill(0), mid: Array(n).fill(0) };
    return Object.assign({ swing: SWING_MIN, swingGrid: 8 }, b);
  }
  /** 小節頭からの位置（4分音符単位）でのスイングのずれ（4分音符単位）。8分スイングは4分の中、16分スイングは8分の中で裏を swing% の位置へ動かす */
  function swingShift(b, q) {
    const r = Math.max(SWING_MIN, Math.min(SWING_MAX, b.swing == null ? SWING_MIN : b.swing)) / 100;
    if (r === 0.5) return 0;
    const pair = b.swingGrid === 16 ? 0.5 : 1;
    const f = (((q % pair) + pair) % pair) / pair;
    const w = f < 0.5 ? f * 2 * r : r + (f - 0.5) * 2 * (1 - r);
    return (w - f) * pair;
  }
  /** swingShift の逆: スイングのかかった位置 q（4分音符単位）を、まっすぐな位置へ戻すずれ（4分音符単位）。ノーマライズでスイングを取るのに使う */
  function swingUnshift(b, q) {
    const r = Math.max(SWING_MIN, Math.min(SWING_MAX, b.swing == null ? SWING_MIN : b.swing)) / 100;
    if (r === 0.5) return 0;
    const pair = b.swingGrid === 16 ? 0.5 : 1;
    const w = (((q % pair) + pair) % pair) / pair;
    const f = w < r ? w / (2 * r) : 0.5 + (w - r) / (2 * (1 - r));
    return (f - w) * pair;
  }
  /** 小節内の位置（拍単位。0..n）での拍ごとのずれ(ms)。拍の中は、拍頭どうしの直線に放物線の膨らみ（中央で mid）を足す */
  function beatShiftAt(b, x) {
    const n = b.at.length;
    const i = Math.max(0, Math.min(n - 1, Math.floor(x)));
    const f = Math.max(0, Math.min(1, x - i));
    const a = b.at[i];
    const next = b.at[(i + 1) % n]; // 最後の拍の次は次の小節の1拍目
    return a + (next - a) * f + 4 * b.mid[i] * f * (1 - f);
  }

  // 旧形式の「小節内の呼吸の型」（breathShape × breath）。旧プリセットの読み込みと既定値に使う
  const LEGACY_BREATH = {
    // 最後の拍でタメ、その前はわずかに前がかり（劇伴系ピアノ書法の聴感ベース）
    tame4: {
      4: [[0, 0], [1, 0], [2, -4], [2.8, -6], [2.96, 6], [3.5, 12], [4, 0]],
      3: [[0, 0], [1, -4], [1.8, -6], [1.96, 6], [2.5, 12], [3, 0]],
      2: [[0, 0], [0.8, -6], [0.96, 6], [1.5, 12], [2, 0]],
    },
    // 後半で前のめりになり、小節頭に遅れて着地（draft/Piano.mid の実測）
    landLate: {
      4: [[0, 25], [1, 13], [1.5, -10], [2, -20], [3, -39], [3.5, -60], [4, 25]],
      3: [[0, 25], [1, -20], [2, -39], [2.5, -60], [3, 25]],
      2: [[0, 25], [1, -39], [1.5, -60], [2, 25]],
    },
  };
  /** 旧形式の型を拍頭と拍の中央で読み取り、拍ごとのずれにする */
  function legacyBeatShift(shape, scale) {
    const out = {};
    for (const [n, pts] of Object.entries(LEGACY_BREATH[shape] || LEGACY_BREATH.tame4)) {
      const at = Array.from({ length: n }, (_, i) => clampShift(MH.interp(pts, i) * scale));
      const mid = at.map((a, i) => clampShift(MH.interp(pts, i + 0.5) * scale - (a + at[(i + 1) % n]) / 2));
      out[n] = { at, mid };
    }
    return out;
  }
  /** 拍ごとのずれの検証（不正な拍数・長さの合わない配列は捨てる。{} は全拍0）。オブジェクトでなければ null */
  function parseBeatShift(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    const ok = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && isFinite(x));
    for (const [key, b] of Object.entries(v)) {
      const n = Number(key);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PULSES || !b || !ok(b.at, n) || !ok(b.mid, n)) continue;
      out[n] = { at: b.at.map(clampShift), mid: b.mid.map(clampShift) };
      // スイングは既定（50%・8分）以外のときだけ持つ
      if (typeof b.swing === 'number' && isFinite(b.swing) && b.swing > SWING_MIN) out[n].swing = Math.min(SWING_MAX, Math.round(b.swing * 10) / 10);
      if (b.swingGrid === 16) out[n].swingGrid = 16;
    }
    return out;
  }
  // ギターの1小節のパターン（16分のマスごと）。拍子は "4/4" などの文字列（2/4・2/2・6/8 は拍の分け方が違うため拍数ではなく拍子で持つ）。値の無い拍子は既定の型
  //   強弱（strumPattern。ヒューマナイズのベロシティ欄。プリセットに含む）: { 拍子: { acc: 各マスの強弱（ベロシティの加減） } }
  //   強拍（strumStrongPattern。楽器固有の詳細設定）: 強弱と同じ形。プラスのマスを方向・奏法の判定で強拍とみなす（ベロシティには効かない）
  //     "*": { scale } は既定の型の強弱の強さ（旧「拍頭アクセント」beatAccent から変換したプリセットだけが持つ。無ければ 6）
  //   方向（strumDirPattern。楽器固有の詳細設定）: { 拍子: 各マスのストローク方向（'D'/'U'）の配列 }
  //   奏法（strumArticPattern。楽器固有の詳細設定）: { 拍子: 各マスの奏法（'N'=通常 / 'X'=ブラッシング / 'P'=パームミュート）の配列 }
  //   旧形式の strumPattern は { acc, dir } を持っていた（方向は楽器固有の詳細設定に移したため、読み込むときに捨てる）
  const STRUM_ACC_MAX = 20;
  const MAX_STRUM_SLOTS = 64;
  const LEGACY_BEAT_ACCENT = 6; // 旧「拍頭アクセント」（beatAccent）の既定値。既定の型の強さ
  const strum = (key, label, desc) => ({ type: 'strum', key, label, max: STRUM_ACC_MAX, default: {}, desc: desc || '' });
  const strumDir = (key, label, desc) => ({ type: 'strumDir', key, label, default: {}, desc: desc || '' });
  const strumArtic = (key, label, desc) => ({ type: 'strumArtic', key, label, default: {}, desc: desc || '' });
  /** ミュート奏法: N=通常、X=ブラッシング（×）、P=パームミュート（PM） */
  const ARTICS = ['N', 'X', 'P'];
  // 正負で丸め方がそろうように絶対値で丸める（-2.5 → -3）
  const clampAcc = (v) => {
    const c = Math.max(-STRUM_ACC_MAX, Math.min(STRUM_ACC_MAX, v));
    return Math.sign(c) * Math.round(Math.abs(c)) + 0; // -0 を 0 にする
  };
  /** 旧「拍頭アクセント」の式（level は maps.position の値。0=小節頭, 1=拍頭, 2=拍の半分, 3以上=それより細かい） */
  const legacyAccent = (level, scale = LEGACY_BEAT_ACCENT) => (level === 0 ? scale : level === 1 ? scale / 2 : level === 2 ? 0 : -scale / 2);
  /** 拍子の1小節のマスの数と、1拍のマスの数（16分が単位。x/32 などは1/拍子の分母が単位）。扱えない拍子は null */
  function strumGrid(meter) {
    const m = /^(\d+)\/(\d+)$/.exec(meter || '');
    if (!m) return null;
    const num = Number(m[1]);
    const den = Number(m[2]);
    const perNote = den <= 16 ? 16 / den : 1; // 1/den 音符あたりのマス
    const slots = num * perNote;
    if (!Number.isInteger(perNote) || slots < 1 || slots > MAX_STRUM_SLOTS) return null;
    const compound = den >= 8 && num % 3 === 0 && num > 3; // 付点4分（3/den）を1拍
    return { slots, perBeat: (compound ? 3 : 1) * perNote, compound, unit: den <= 16 ? '16分' : `${den}分` };
  }
  /**
   * 既定の型: 強弱は旧「拍頭アクセント」の式（小節頭 +a、拍頭 +a/2、拍の半分 0、それより細かい −a/2）
   * 方向は表拍=ダウン・裏拍=アップの交互: 16分のストロークがある曲（use16）は16分ごと、無ければ8分ごとに ↓↑ を交互（複合拍子は常に8分ごとで、拍ごとに ↓ から数え直す。間のマスは近い方）
   */
  function defaultStrumPattern(meter, scale = LEGACY_BEAT_ACCENT, use16 = false) {
    const g = strumGrid(meter);
    if (!g) return null;
    const half = g.compound ? g.perBeat / 3 : g.perBeat / 2; // 拍の半分（複合拍子は8分）
    const acc = Array.from({ length: g.slots }, (_, s) => clampAcc(legacyAccent(s === 0 ? 0 : s % g.perBeat === 0 ? 1 : Number.isInteger(half) && s % half === 0 ? 2 : 3, scale)));
    const step = g.compound ? g.perBeat / 3 : g.perBeat / (use16 ? 4 : 2); // 交互にする単位（マス）。core/analyze.js の strumUse16 と同じ判定
    // 複合拍子は付点4分の拍ごとに数え直す（6/8 なら ↓↑↓ ↓↑↓。推定と同じ）
    const dir = acc.map((_, s) => (Math.round((g.compound ? s % g.perBeat : s) / step) % 2 === 0 ? 'D' : 'U'));
    return { acc, dir };
  }
  /** 既定の型の強弱の強さ（旧形式の強さの項目から変換したプリセットは "*": { scale }、無ければ def）。「型を呼び出す」の強さにも使う */
  const accentScale = (value, def) => (value && value['*'] && typeof value['*'].scale === 'number' ? value['*'].scale : def);
  /** ギターの既定の型の強弱の強さ（旧「拍頭アクセント」から変換したプリセットはその強さ、無ければ 6） */
  const strumAccentScale = (value) => accentScale(value, LEGACY_BEAT_ACCENT);
  /** 拍子 meter の強弱のパターン（{ acc }。値が無い・長さが合わなければ既定の型。扱えない拍子は null） */
  function strumPatternOf(value, meter) {
    const g = strumGrid(meter);
    const b = value && value[meter];
    if (g && b && Array.isArray(b.acc) && b.acc.length === g.slots) return { acc: b.acc };
    const d = defaultStrumPattern(meter, strumAccentScale(value));
    return d && { acc: d.acc };
  }
  /** 拍子 meter の方向のパターン（'D'/'U' の配列。値が無い・長さが合わなければ既定の型＝表拍=ダウン・裏拍=アップの交互。扱えない拍子は null） */
  function strumDirOf(value, meter, use16 = false) {
    const g = strumGrid(meter);
    const b = value && value[meter];
    if (g && Array.isArray(b) && b.length === g.slots && b.every((d) => d === 'D' || d === 'U')) return b;
    const d = defaultStrumPattern(meter, LEGACY_BEAT_ACCENT, use16);
    return d && d.dir;
  }
  /** 小節内の位置（ticks）に最も近いマスの番号 */
  function strumSlotAt(meter, posInBar, barTicks) {
    const g = strumGrid(meter);
    return g ? Math.round((posInBar / barTicks) * g.slots) % g.slots : 0;
  }
  /** 拍子 meter の奏法のパターン（'N'/'X'/'P' の配列。値が無い・不正なら既定＝すべて通常。扱えない拍子は null） */
  function strumArticOf(value, meter) {
    const g = strumGrid(meter);
    if (!g) return null;
    const b = value && value[meter];
    if (Array.isArray(b) && b.length === g.slots && b.every((a) => ARTICS.includes(a))) return b;
    return Array(g.slots).fill('N');
  }
  /** 強弱のパターンの検証（扱えない拍子・長さの合わない配列は捨てる。旧形式の dir は捨てる）。オブジェクトでない・中身がすべて不正なら null */
  function parseStrumPattern(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    for (const [meter, b] of Object.entries(v)) {
      if (meter === '*') {
        if (b && typeof b.scale === 'number' && isFinite(b.scale)) out['*'] = { scale: Math.max(0, Math.min(STRUM_ACC_MAX, b.scale)) };
        continue;
      }
      const g = strumGrid(meter);
      if (!g || !b || !Array.isArray(b.acc) || b.acc.length !== g.slots || !b.acc.every((x) => typeof x === 'number' && isFinite(x))) continue;
      out[meter] = { acc: b.acc.map(clampAcc) };
    }
    return Object.keys(out).length || !Object.keys(v).length ? out : null;
  }
  /** 旧形式の「拍頭アクセント」（強さ1つ）: すべての拍子の既定の型の強さにする */
  function legacyStrumPattern(scale) {
    return { '*': { scale: Math.max(0, Math.min(STRUM_ACC_MAX, scale)) } };
  }
  // ピアノ・ドラムの強弱のパターン（accentGrid）: { 拍子: { acc: 2小節ぶんの16分のマスごとの強弱 } }
  //   奇数小節・偶数小節で前半・後半を交互に使う（2小節の型のため）。値の無い拍子は「拍ごと」の型を既定の強さで埋めたもの
  //   "*": { scale } は既定の型の強さ（旧形式の強さの項目 beatAccent・patternAccent から変換したプリセットだけが持つ。無ければ ACCENT_SCALE）
  const ACCENT_SCALE = { piano: 4, drums: 6 };
  /**
   * 強拍の型 id を拍子 meter の bars 小節ぶん（1 か 2。ギターは1小節）のマスに埋める: 強拍 +amount、強拍でない8分より細かいマス −amount/2、それ以外 0。
   * 使えない拍子・マスに乗らない型・bars より長い型は null
   */
  function accentGridFill(id, meter, amount, bars = 2) {
    const g = strumGrid(meter);
    const pt = MH.ACCENT_PATTERNS.find((x) => x.id === id);
    if (!g || !pt) return null;
    const pg = MH.accentPatternGrid(pt, { pulses: g.slots / g.perBeat, compound: g.compound, meter });
    if (!pg || pg.bars > bars) return null;
    const span = g.slots * pg.bars;
    const strong = new Set();
    for (const a of pg.at) {
      const s = (a * span) / pg.grid;
      if (!Number.isInteger(s)) return null;
      for (let k = s; k < g.slots * bars; k += span) strong.add(k);
    }
    const eighth = g.compound ? g.perBeat / 3 : g.perBeat / 2;
    return Array.from({ length: g.slots * bars }, (_, s) => clampAcc(strong.has(s) ? amount : Number.isInteger(eighth) && (s % g.slots) % eighth !== 0 ? -amount / 2 : 0));
  }
  /** 拍子 meter の強弱のパターン（2小節ぶんの配列。値が無い・長さが合わなければ「拍ごと」の型。扱えない拍子は null）。def は既定の型の強さ */
  function accentGridOf(value, meter, def) {
    const g = strumGrid(meter);
    const b = value && value[meter];
    if (g && b && Array.isArray(b.acc) && b.acc.length === g.slots * 2) return b.acc;
    return accentGridFill('beats', meter, accentScale(value, def));
  }
  /** 位置 pos（maps.position の値）の強弱。扱えない拍子は小節頭・拍頭 +強さ、16分以下 −強さ/2 */
  function accentGridAt(value, pos, def) {
    const acc = accentGridOf(value, pos.meter, def);
    const amount = accentScale(value, def);
    if (!acc) return pos.level <= 1 ? amount : pos.level >= 3 ? -amount / 2 : 0;
    return acc[accentGridSlot(acc, pos)];
  }
  /** 2小節ぶんのマス acc のうち位置 pos に最も近いマスの番号。小節末の音が次の小節頭のマスに丸められたら、次の小節（前半・後半の逆側）のマス */
  function accentGridSlot(acc, pos) {
    const slots = acc.length / 2;
    const raw = Math.round((pos.posInBar / pos.barTicks) * slots);
    return (raw % slots) + ((pos.bar + (raw >= slots ? 1 : 0)) % 2) * slots;
  }
  /** パターン acc のマスの値 v を強拍度（+1＝パターンで最も強いマス、−1＝最も弱いマス、0＝加減なし）に直す */
  function accentLevel(acc, v) {
    if (v > 0) return v / Math.max(...acc);
    if (v < 0) return v / -Math.min(...acc);
    return 0;
  }
  /** ピアノ・ドラムの位置 pos の強拍度（-1〜+1）。扱えない拍子は小節頭・拍頭 +1、16分以下 −1 */
  function accentGridLevelAt(value, pos, def) {
    const acc = accentGridOf(value, pos.meter, def);
    if (!acc) return pos.level <= 1 ? 1 : pos.level >= 3 ? -1 : 0;
    return accentLevel(acc, acc[accentGridSlot(acc, pos)]);
  }
  /** ギターの位置 pos の強拍度（-1〜+1）。扱えない拍子は旧「拍頭アクセント」の式（小節頭 +1、拍頭 +0.5、拍の半分 0、それより細かい −1） */
  function strumAccentLevelAt(value, pos) {
    const pat = strumPatternOf(value, pos.meter);
    if (!pat) return legacyAccent(pos.level, 1) * (pos.level >= 3 ? 2 : 1);
    return accentLevel(pat.acc, pat.acc[strumSlotAt(pos.meter, pos.posInBar, pos.barTicks)]);
  }
  /** 強拍度 lv に応じたランダム幅の倍率: 強拍で (1−diff) 倍、弱拍で (1+diff) 倍（中間は比例） */
  const accentSdScale = (lv, diff) => 1 - diff * lv;
  /** 強弱のパターンの検証（扱えない拍子・長さの合わない配列は捨てる）。オブジェクトでない・中身がすべて不正なら null */
  function parseAccentGrid(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    for (const [meter, b] of Object.entries(v)) {
      if (meter === '*') {
        if (b && typeof b.scale === 'number' && isFinite(b.scale)) out['*'] = { scale: Math.max(0, Math.min(STRUM_ACC_MAX, b.scale)) };
        continue;
      }
      const g = strumGrid(meter);
      if (!g || !b || !Array.isArray(b.acc) || b.acc.length !== g.slots * 2|| !b.acc.every((x) => typeof x === 'number' && isFinite(x))) continue;
      out[meter] = { acc: b.acc.map(clampAcc) };
    }
    return Object.keys(out).length || !Object.keys(v).length ? out : null;
  }
  // amount: 既定の型の強さ（値の無い拍子の既定の型と、型を呼び出すときの強さに使う。値に "*": { scale } があればそちら）
  const accentGrid = (key, label, amount, desc) => ({ type: 'accentGrid', key, label, max: STRUM_ACC_MAX, amount, default: {}, desc: desc || '' });
  const BULK_DESC = '上端の帯を上下にドラッグするとプラスのマス（強拍）を、下端の帯を上下にドラッグするとマイナスのマス（弱拍）を、比率を保ったまままとめて強める・弱める';
  /** ピアノ・ドラムの強弱のパターン（ヒューマナイズのベロシティ欄。プリセットに含む）。既定の型の強さは ACCENT_SCALE[instrument]。extra は説明の追記 */
  const ACCENT_PATTERN = (instrument, extra = '') =>
    accentGrid('accentGrid', '強弱のパターン', ACCENT_SCALE[instrument], '2小節の16分のマスごとに、強弱（ベロシティの加減）を決める。奇数小節に前半、偶数小節に後半を使う。「型を呼び出す」で型を選ぶと、強拍のマスに +' + ACCENT_SCALE[instrument] + '（旧形式の強さの項目から変換したプリセットはその強さ）、強拍でない8分より細かいマスにその半分のマイナスを入れる（その後は手で直せる。その拍子で使えない型は出さない）。棒を上下にドラッグ（横になぞると続けて描く）、ダブルクリックで0。' + BULK_DESC + '。値の無い拍子は「拍ごと」の型を使う。拍子ごとに別々に持ち、開いている曲の拍子の分を表示する' + extra);
  // 強弱のパターンを参照する項目（ベロシティ欄）。効き方は強拍度（パターンで最も強いマス＝+1、最も弱いマス＝−1、0のマス＝0）に比例する
  const LEVEL_DESC = '強拍・弱拍は「強弱のパターン」で決まり、パターンで最も強いマスで最大、最も弱いマスで最大（逆向き）、0のマスでは効かない（間のマスは値に比例）';
  const ACCENT_VEL = () => [
    num('accentVelDepth', '強弱のパターンの反映量', 0, 2, 0.05, 1, '倍', '「強弱のパターン」の値に掛ける倍率（0＝パターンの加減を使わない）。ランダム幅の強拍・弱拍差への効き方は変わらない'),
    num('accentVelSdDiff', 'ランダム幅の強拍・弱拍差', -0.9, 0.9, 0.05, 0, '比', 'ランダム幅を、強拍で (1−値) 倍、弱拍で (1+値) 倍にする。プラス＝強拍は安定して弱拍はばらつく、マイナスはその逆。' + LEVEL_DESC),
  ];
  // 別の項目（select・bool）が指定の値のときだけ表示する
  const when = (key, values, item) => Object.assign(item, { when: { key, values } });
  // ピアノの左手・右手どちらに効く項目かの印（UIで色付きのタグを付ける）
  const R = (item) => Object.assign(item, { hand: 'right' });
  const L = (item) => Object.assign(item, { hand: 'left' });

  const PHRASE = [
    num('phraseBars', 'フレーズ最大小節数', 1, 16, 1, 4, '小節', 'この小節数を超えたらフレーズを区切る。区切りはファイルを開いたときに検出し、変更は「再検出する」で反映する'),
    num('phraseGapBeats', 'フレーズ区切りの休符', 0.25, 4, 0.25, 1, '拍', 'これ以上の休符があればフレーズを区切る。区切りはファイルを開いたときに検出し、変更は「再検出する」で反映する'),
  ];
  // 抑揚（自動）: 抑揚のレーンの値を作る山なりの形（値を変えて実行すると、その区間のレーンの値と混ぜる。app.js の run）。ベロシティのグループの入れ子に置く
  const EXPR_AUTO = '抑揚（自動）';
  const EXPR_AUTO_DESC = '抑揚のレーンの値を作る。値を変えて実行すると、その区間のレーンの値と平均する（プリセットの切り替えでは置き換える）';
  const exprAuto = (item) => Object.assign(item, { desc: (item.desc ? item.desc + '。' : '') + EXPR_AUTO_DESC });
  // フレーズ内の山なりカーブの頂点（ピアノ・ギター）
  const ARC_PEAK = (extra) =>
    exprAuto(num('arcPeak', 'フレーズの山の位置', 0.1, 0.9, 0.05, 0.65, '', 'フレーズ内で最も強くなる位置（0=頭, 1=末尾）。各「山の高さ」の強弱はこの位置で最も強く、フレーズの頭・末尾に向けて弱くなる。' + extra));

  // ベロシティの基準: 固定＝計算した値をそのまま使う、相対＝元のベロシティが基準値からずれた分を足す
  const VEL_REF = (desc) => select('velRef', 'ベロシティ基準', [['fixed', '固定（基準値一定）'], ['relative', '相対（基準値から相対変化）']], 'fixed', '相対: 元のベロシティと基準値（' + desc + '）との差を、計算したベロシティに足す。元の強弱を活かしたいとき（ベタ打ちでないMIDI）向け。基準値は打ち消し合って効かないので、相対のときは隠す');
  // 基準値の項目: ベロシティ基準「相対」では打ち消し合って効かないので隠す
  const VEL_BASE = (item) => when('velRef', ['fixed'], item);

  // 各グループの cat は設定の大項目（instrument=一般の「楽器固有の詳細設定」のモーダル（プリセットとは切り離して楽器ごとに値を持つ）、省略=ヒューマナイズ）
  const SCHEMA = {
    piano: [
      {
        group: '「左手／右手」の判定',
        cat: 'instrument',
        items: [
          select('handMode', '判定方法', [['melody', '自動（右手＝旋律中心）'], ['auto', '自動（均等）'], ['split', '固定の音高で分ける']], 'melody', 'ファイル読み込み時と、この欄の「再判定する」で使う（実行しても判定し直さない）。右手＝旋律中心: 和音の最高音を右手、それ以外は左手が届く限り左手にする。均等: 手の届く範囲・直前の位置だけから推定する。どれもピアノロールでノートごとに修正できる'),
          when('handMode', ['melody', 'auto'], num('handSpan', '片手で届く幅', 9, 16, 1, 12, '半音', '自動のとき、片手で無理なく押さえられる幅（12=1オクターブ）。超える和音は両手で分担する')),
          when('handMode', ['split'], num('splitPitch', '固定の分割音高', 36, 84, 1, 60, 'note', '「固定の音高で分ける」のとき、これ以上を右手とする（60=C3）')),
        ],
      },
      {
        group: 'ベロシティ',
        items: [
          VEL_REF('右手は「旋律の基準」、左手は「基準」'),
          ACCENT_PATTERN('piano'),
          num('velJitter', 'ランダム幅', 0, 20, 0.5, 4, 'σ', 'ばらつきの標準偏差（σ：平均からの散らばり具合）'),
          ...ACCENT_VEL(),
          VEL_BASE(R(num('melodyVelBase', '旋律の基準', 1, 127, 1, 74, '', '右手の最高音（旋律）の強さ'))),
          R(num('rhInnerVelOffset', '内声の弱め量', 0, 40, 1, 14, '', '右手の旋律以外の音を、旋律の基準からどれだけ弱くするか')),
          R(num('phraseEndSoften', 'フレーズ末尾の減衰', 0, 30, 1, 6, '', '')),
          VEL_BASE(L(num('accompVelBase', '基準', 1, 127, 1, 50, '', '伴奏は弱めで一定が基本'))),
          L(num('bassBoost', '最低音の強調', -10, 20, 1, 4, '', '左手で和音を弾くとき、最低音（ベース）をどれだけ強くするか')),
        ],
        groups: [
          {
            group: EXPR_AUTO,
            items: [
              ARC_PEAK('左手・右手の両方に効く。'),
              R(exprAuto(num('melodyVelArc', '旋律の山の高さ', 0, 60, 1, 26, '', 'フレーズ内の山なりの強弱の大きさ（山の頂点と谷のベロシティの差）。大きいほどドラマチック'))),
              R(exprAuto(num('rhInnerArcRatio', '内声の山の追従', 0, 1, 0.05, 0.5, '倍', '旋律の山なりにどれだけ付いていくか（0=一定, 1=旋律と同じ高さ）'))),
              L(exprAuto(num('accompVelArc', '山の高さ', 0, 40, 1, 6, '', 'フレーズ内の山なりの強弱の大きさ（山の頂点と谷のベロシティの差）'))),
            ],
          },
        ],
      },
      {
        group: 'タイミング',
        items: [
          beats('beatShift', '拍ごとのタメ・走り', legacyBeatShift('tame4', 1), '左手・右手のタイミングを拍ごとに同じだけずらす。▲＝拍頭のずれ、◆＝拍の途中のずれ（右へ動かすと拍の前半を溜めて後半で取り戻し、左へ動かすと前半を走って後半で戻る）。右＝遅らせる（タメ）、左＝早める（走り）。スイング（ハネ）は下の「スイング」で、ハネさせる音価（8分・16分）と裏の位置（50%＝イーブン、66.7%＝三連、75%＝付点。ダブルクリックでイーブンに戻す）を指定する。ドラッグで動かし、ダブルクリックで0に戻す。配置は1小節の拍数ごとに別々に持ち、開いている曲の拍子の分を表示する（6/8 は付点4分を1拍として2拍）。途中で拍子が変わる曲では、各小節の拍数の配置を使う'),
          num('chordSpreadMs', '和音のばらけ', 0, 40, 1, 8, 'ms', '左手の和音を低音から順にずらす最大量（右手内声はその半分）'),
          R(num('melodyTimingSd', '揺れ', 0, 40, 1, 9, 'ms', '右手（旋律・内声）のタイミングの揺れ（ルバート）')),
          R(num('melodyLeadMs', '旋律の先行', -40, 30, 1, 5, 'ms', '右手の旋律を他の音よりわずかに早く弾く（メロディリード）。マイナスは旋律が遅れて歌う')),
          R(num('phraseEndRitMs', 'フレーズ末尾のタメ', 0, 80, 1, 22, 'ms', '')),
          L(num('accompTimingSd', '揺れ', 0, 30, 1, 3, 'ms', 'オスティナート（反復伴奏）は正確に保つ')),
        ],
      },
      {
        group: '長さ',
        items: [
          num('lengthJitter', '長さのランダム幅', 0, 0.3, 0.01, 0.06, '比', ''),
          R(num('legatoMs', '旋律のレガート重なり', 0, 80, 1, 18, 'ms', '次の音に重ねる長さ')),
          R(num('phraseEndExtend', 'フレーズ末尾の延長', 0, 1, 0.05, 0.15, '比', '')),
          L(num('accompLengthRatio', '長さ比', 0.3, 1.2, 0.01, 0.92, '倍', '')),
        ],
      },
      {
        group: 'サステインペダル',
        cat: 'instrument',
        items: [
          bool('pedal', 'ペダルを書き込む', false, '小節頭で踏み替える。小節線をまたいで押さえている音があれば、その小節線では踏み替えない'),
          when('pedal', [true], bool('pedalOnChordChange', 'コードが変わる小節線では必ず踏み替える', true, '小節ごとにコードを判定し、前の小節の響きが残ると濁るコードに変わる小節線では、押さえている音があっても踏み替える。最低音だけが動く場合（C→C/E）や、前のコードの音が次のコードの構成音・テンション1音までに収まる場合（G→Em7、C→Am）は濁らないとみなし、従来どおりに扱う')),
          when('pedal', [true], num('pedalReleaseMs', '踏み替え: 上げるまで', 0, 120, 1, 15, 'ms', '小節頭の音を弾いてからペダルを上げるまで')),
          when('pedal', [true], num('pedalPressMs', '踏み替え: 踏むまで', 10, 250, 1, 70, 'ms', '小節頭の音を弾いてからペダルを踏み直すまで')),
          when('pedal', [true], num('pedalDepth', '踏み込み量', 64, 127, 1, 112, '', '')),
          when('pedal', [true], num('pedalRestBeats', '休符でペダルを離す長さ', 0.5, 8, 0.5, 1.5, '拍', '')),
        ],
      },
      { group: 'フレーズ検出', cat: 'instrument', items: PHRASE },
    ],

    guitar: [
      {
        group: 'ベロシティ',
        items: [
          VEL_REF('「基準」'),
          strum('strumPattern', '強弱のパターン', '1小節の16分のマスごとに、強弱（ベロシティの加減）を決める。「型を呼び出す」で型を選ぶと、強拍のマスに +6（旧「拍頭アクセント」から変換したプリセットはその強さ）、強拍でない8分より細かいマスにその半分のマイナスを入れる（その拍子で使えない型・2小節の型は出さない）。棒を上下にドラッグ（横になぞると続けて描く）、ダブルクリックで0。' + BULK_DESC + '。マスの間の音は最も近いマスの値を使う。パターンは拍子ごとに別々に持ち、開いている曲の拍子の分を表示する。途中で拍子が変わる曲では、各小節の拍子のパターンを使う。ストロークの方向・奏法の判定に使う強拍は「楽器固有の詳細設定」の「強拍のパターン」で決める'),
          VEL_BASE(num('velBase', '基準', 1, 127, 1, 80, '', '')),
          num('downVelBoost', 'ダウンストロークの強調', 0, 25, 1, 6, '', ''),
          num('upVelCut', 'アップストロークの減衰', 0, 30, 1, 10, '', ''),
          num('stringVelDecay', '弦ごとの減衰', 0, 6, 0.1, 1.2, '/弦', '掻いた順に少しずつ弱くなる'),
          num('brushVelCut', 'ブラッシングの弱め量', 0, 60, 1, 18, '', 'ブラッシングのベロシティを下げる量'),
          num('pmVelCut', 'パームミュートの弱め量', 0, 40, 1, 8, '', 'ベロシティを下げる量'),
          num('pmHighCut', 'パームミュートの高音弦の弱め', 0, 30, 1, 8, '', '高い音ほど追加で弱める量（最高音でこの値。手のひらで押さえる低音弦は残りやすい）'),
          num('velJitter', 'ランダム幅', 0, 20, 0.5, 5, 'σ', ''),
          ...ACCENT_VEL(),
        ],
        groups: [
          {
            group: EXPR_AUTO,
            items: [exprAuto(num('phraseArc', 'フレーズの山の高さ', 0, 50, 1, 14, '', 'フレーズ内の山なりの強弱の大きさ（山の頂点と谷のベロシティの差）')), ARC_PEAK('')],
          },
        ],
      },
      {
        group: 'タイミング',
        items: [
          num('strumDownMs', 'ダウンの掻き時間（6弦換算）', 0, 120, 1, 32, 'ms', '1弦目から最後の弦までの時間'),
          num('strumUpMs', 'アップの掻き時間（6弦換算）', 0, 120, 1, 20, 'ms', ''),
          num('strumSpreadJitter', '掻き時間のばらつき', 0, 0.6, 0.01, 0.2, '比', ''),
          num('brushSpreadRatio', 'ブラッシングの掻き時間', 0.2, 1.5, 0.05, 0.6, '比', '通常の掻き時間に対する比（速く掻くほど小さい）'),
          num('timingSd', '揺れ', 0, 40, 1, 7, 'ms', ''),
          beats('beatShift', '拍ごとのタメ・走り', {}, 'すべての音（和音・単音）のタイミングを拍ごとにずらす（和音は掻き始めの位置ごとずらす）。▲＝拍頭のずれ、◆＝拍の途中のずれ（右へ動かすと拍の前半を溜めて後半で取り戻し、左へ動かすと前半を走って後半で戻る）。右＝遅らせる（タメ）、左＝早める（走り）。スイング（ハネ）は下の「スイング」で、ハネさせる音価（8分・16分）と裏の位置（50%＝イーブン、66.7%＝三連、75%＝付点。ダブルクリックでイーブンに戻す）を指定する。ドラッグで動かし、ダブルクリックで0に戻す。配置は1小節の拍数ごとに別々に持ち、開いている曲の拍子の分を表示する（6/8 は付点4分を1拍として2拍）。途中で拍子が変わる曲では、各小節の拍数の配置を使う'),
        ],
      },
      {
        group: '長さ',
        items: [
          num('muteGapMs', '次のストローク前の音切れ', 0, 80, 1, 18, 'ms', ''),
          bool('muteOnChordChange', 'コードが変わる小節線で前の音を止める', true, '小節ごとにコードを判定し、前の小節の響きが残ると濁るコードに変わる小節線では、小節線をまたいで鳴っている音を「次のストローク前の音切れ」の分だけ手前で止める。最低音だけが動く場合（C→C/E）や、前のコードの音が次のコードの構成音・テンション1音までに収まる場合（G→Em7、C→Am）は止めない'),
          num('letRing', '単音の余韻（let ring）', 0, 1, 0.05, 0.5, '比', 'アルペジオの音を次の小節頭までどれだけ伸ばすか。リードは0推奨'),
          num('ringMaxBeats', '余韻の最大長', 0.5, 8, 0.5, 4, '拍', ''),
          num('brushMs', 'ブラッシングの長さ', 10, 200, 1, 40, 'ms', 'ブラッシング（×）の音の長さ'),
          num('pmLenRatio', 'パームミュートの長さ', 0.05, 1, 0.05, 0.35, '比', 'パームミュート（PM）の音を元の長さのこの比にする'),
          num('pmMaxMs', 'パームミュートの最大長', 30, 1000, 10, 250, 'ms', 'これより長くしない'),
          num('lengthJitter', '長さのランダム幅', 0, 0.3, 0.01, 0.05, '比', ''),
        ],
      },
      {
        group: 'ストロークの方向・奏法',
        cat: 'instrument',
        items: [
          strum('strumStrongPattern', '強拍のパターン', 'ファイルを開いたときの方向・奏法の判定に使う強拍を、1小節の16分のマスごとに決める。プラスのマスの和音を強拍とみなし、方向の推定でダウン寄りにし、ミュート奏法の推定でミュート・ブラッシングにしない（ベロシティには効かない。強弱はヒューマナイズの「ベロシティ」の「強弱のパターン」で決める）。変えたときは「再判定する」で反映する。「型を呼び出す」で型を選ぶと、強拍のマスにプラス、強拍でない8分より細かいマスにマイナスを入れる。棒を上下にドラッグ（横になぞると続けて描く）、ダブルクリックで0。マスの間の音は最も近いマスの値を使う。拍子ごとに別々に持ち、開いている曲の拍子の分を表示する。値の無い拍子は小節頭・拍頭を強拍とする'),
          num('strumMinNotes', 'ストローク判定の最小音数', 2, 6, 1, 3, '音', ''),
          select('strumMode', 'ストローク方向',[['smart', '推定'], ['pattern', 'パターン指定']], 'smart', '和音ごとのダウン／アップの決め方。ファイルを開いたときに判定し、変更は「再判定する」で反映する（ピアノロールで直した方向も解除される）。推定: 表拍=ダウン・裏拍=アップを基本に、元のMIDIの強さ・長さ・弦の数と低音・弦ごとの発音順から和音ごとにダウンらしさを決め、間隔の短い和音が同じ方向に続かないように並びを選ぶ（8分か16分かは前後1小節の和音で決める。ベタ打ちのMIDIでは ↓↑ の交互になる）。パターン指定: 下の「方向のパターン」を使う'),
          when('strumMode', ['smart'], num('estBeat', '推定: 拍の位置の重み', 0, 3, 0.1, 1, '', '表拍（偶数マス）ほどダウン、裏拍ほどアップとみなす強さ')),
          when('strumMode', ['smart'], num('estVel', '推定: 強さの重み', 0, 3, 0.1, 0.8, '', '近くの和音より強い（ベロシティが大きい）ほどダウンとみなす強さ')),
          when('strumMode', ['smart'], num('estLen', '推定: 長さの重み', 0, 3, 0.1, 0.4, '', '近くの和音より長く伸ばすほどダウンとみなす強さ')),
          when('strumMode', ['smart'], num('estVoicing', '推定: ボイシングの重み', 0, 3, 0.1, 0.5, '', '近くの和音より弦の数が多い・低い音を含むほどダウンとみなす強さ（アップは高音弦だけを掻きやすい）')),
          when('strumMode', ['smart'], num('estOrder', '推定: 発音順の重み', 0, 3, 0.1, 1.5, '', '元のMIDIで弦ごとに発音がずれているとき、低音が先ならダウン、高音が先ならアップとみなす強さ')),
          when('strumMode', ['smart'], num('estFlow', '推定: 振りのつながりの重み', 0, 3, 0.1, 1, '', '間隔の短い（250ms 未満）和音が同じ方向に続くのを避ける強さ（手の往復が間に合わないため）')),
          strumDir('strumDirPattern', '方向のパターン', '1小節の16分のマスごとのストロークの方向。矢印をクリックで ↓⇔↑（なぞると同じ向きにそろう）。ストローク方向が「パターン指定」のときだけ使う（推定のときは薄く表示する）。マスの間の音は最も近いマスの値を使う。拍子ごとに別々に持ち、開いている曲の拍子の分を表示する'),
          select('articMode', 'ミュート奏法', [['smart', '推定'], ['pattern', 'パターン指定']], 'smart', '同時発音ごとの奏法（通常／×ブラッシング／PMパームミュート）の決め方。ファイルを開いたときに判定し、変更は「再判定する」で反映する（ピアノロールで直した奏法も解除される）。推定: 下の「ブラッシングとみなす長さ」以下の和音を×、低い音域（E3 以下）で短く切った音が3つ以上続く部分をPM（単音の刻みも含む）、アップの和音でごく短く近くより弱いものを×とみなす。パターン指定: 下の「奏法のパターン」を使う'),
          strumArtic('strumArticPattern', '奏法のパターン', '1小節の16分のマスごとのミュート奏法。クリックで 通常 → ×（ブラッシング）→ PM（パームミュート）の順に切り替える（なぞると同じ奏法にそろう）。ミュート奏法が「パターン指定」のときだけ使う（推定のときは薄く表示する）。マスの間の音は最も近いマスの値を使う。拍子ごとに別々に持ち、開いている曲の拍子の分を表示する'),
          when('articMode', ['smart'], num('brushDetectBeats', 'ブラッシングとみなす長さ', 0, 0.5, 0.0625, 0.125, '拍', '元のMIDIで、すべての音がこの長さ以下の和音をブラッシング（×）と判定する（単音は速いリードと区別できないので判定しない）。0 で判定しない。既定 0.125 拍＝32分音符')),
        ],
      },
      {
        group: 'ミュート奏法の出力',
        cat: 'instrument',
        items: [
          select('articOutput', '出力のしかた', [['none', '長さ・強さのみ'], ['keyswitch', 'キースイッチ'], ['program', '音色の切り替え（プログラムチェンジ）']], 'none', 'ブラッシング・パームミュートを書き出すMIDIでどう表すか。長さ・強さのみ: ヒューマナイズで長さと強さを変えるだけ（どの音源でも使える）。キースイッチ: 奏法が変わる和音の直前に、奏法を切り替える音（キースイッチ）を書く（ギター音源向け）。音色の切り替え: 奏法が変わる和音の直前にプログラムチェンジを書く（GM音源向け。ブラッシング・パームミュートはどちらもミュートの音色。曲頭は通常の音色とみなし、通常に戻すときは元の音色ではなく「通常の音色」の番号を書く）。書き出し時だけ使い、試聴には影響しない'),
          when('articOutput', ['keyswitch'], num('ksNormal', 'キースイッチ: 通常', 0, 127, 1, 24, 'note', '使う音源のキースイッチに合わせる')),
          when('articOutput', ['keyswitch'], num('ksBrush', 'キースイッチ: ブラッシング', 0, 127, 1, 26, 'note', '')),
          when('articOutput', ['keyswitch'], num('ksPalm', 'キースイッチ: パームミュート', 0, 127, 1, 28, 'note', '')),
          when('articOutput', ['program'], num('pcNormal', '通常の音色', 1, 128, 1, 25, '', 'GM の番号（1〜128）。25 = Acoustic Guitar (steel)')),
          when('articOutput', ['program'], num('pcMute', 'ミュートの音色', 1, 128, 1, 29, '', 'GM の番号（1〜128）。29 = Electric Guitar (muted)')),
        ],
      },
      {
        group: 'ビブラート',
        cat: 'instrument',
        items: [
          select('vibrato', '方式', [['off', 'なし'], ['cc1', 'CC1（モジュレーション）'], ['pb', 'ピッチベンド']], 'off', '長い単音に遅れてビブラートをかける。CC1 は揺らし方を音源に任せる。CC1 にビブラートが割り当てられていない音源ではピッチベンドを使う。ピッチベンドは元のピッチベンドをすべて置き換え、チャンネル全体に効く（揺らしている間は余韻で鳴っている他の音も揺れるため、次の音が鳴る位置で0に戻す）'),
          when('vibrato', ['cc1', 'pb'], num('modMinBeats', '対象の最短音長', 0.5, 8, 0.5, 1.5, '拍', '')),
          when('vibrato', ['cc1'], num('modDepth', 'CC1 深さ', 0, 127, 1, 40, '', '')),
          when('vibrato', ['pb'], num('pbRange', 'ピッチベンド幅（音源の設定）', 1, 24, 1, 2, '半音', '音源のピッチベンドの最大幅に合わせる。振幅（セント）をピッチベンドの値に換算するのに使う')),
          when('vibrato', ['pb'], wave('vibWave', '振幅パターン', SINE_WAVE, '波形1周ぶん。ドラッグで描く（上＝音が高い）')),
          when('vibrato', ['pb'], num('vibLoopBeats', '1ループの長さ', 0.125, 4, 0.125, 0.5, '拍', '波形1周の長さ')),
          when('vibrato', ['pb'], num('vibDepth', '振幅', 0, 200, 1, 30, 'セント', '波形の最大の振れ幅（100セント＝半音）')),
          when('vibrato', ['pb'], num('vibDepthRand', '振幅（ランダマイズ）', 0, 1, 0.05, 0.2, '比', '振幅を時間とともにゆっくり揺らがせる量（AM変調）')),
          when('vibrato', ['pb'], num('vibSpeed', '速さ', 0.25, 4, 0.05, 1, '倍', '実際の周期＝1ループの長さ÷速さ')),
          when('vibrato', ['pb'], num('vibSpeedRand', '速さ（ランダマイズ）', 0, 1, 0.05, 0.1, '比', '速さを時間とともにゆっくり揺らがせる量（FM変調）')),
          when('vibrato', ['pb'], num('vibDelayMs', '開始時間', 0, 2000, 10, 250, 'ms', '発音してから揺れ始めるまで')),
          when('vibrato', ['pb'], num('vibFadeInMs', 'フェードイン', 0, 2000, 10, 300, 'ms', '揺れ始めてから振幅が最大になるまで')),
          when('vibrato', ['pb'], num('vibFadeOutMs', 'フェードアウト', 0, 2000, 10, 100, 'ms', '音の終わり（次の音が鳴る位置）に向けて振幅を0に戻す長さ')),
        ],
      },
      { group: 'フレーズ検出', cat: 'instrument', items: PHRASE },
    ],

    drums: [
      {
        group: 'ベロシティ',
        // 全パーツに効く項目を先に並べ、パーツ別の項目は入れ子のグループにする（タイミングも同じパーツの区切り）。キーは旧版と同じものを残す（hatVel＝閉、cymbalVel＝クラッシュ）
        items: [
          VEL_REF('各パーツの「音量」。スネアの「音量」はゴーストノートの強さとの差が効くので、相対でも隠さない'),
          ACCENT_PATTERN('drums', '。パターンの値はすべてのパーツに足す。プラスのマス（強拍）の音は裏拍・16分の位置で弱めない（スネアはゴーストノートにしない）'),
          num('velJitter', 'ランダム幅', 0, 20, 0.5, 5, 'σ', ''),
          ...ACCENT_VEL(),
        ],
        groups: [
          {
            group: EXPR_AUTO,
            items: [exprAuto(num('phraseBars', '盛り上がりの周期', 1, 16, 1, 4, '小節', '')), exprAuto(num('phraseArc', '周期内の盛り上がり幅', 0, 30, 1, 6, '', '周期の頭で −半分、終わりで +半分になるよう、まっすぐ強めていく'))],
          },
          {
            group: 'キック',
            items: [
              VEL_BASE(num('kickVel', '音量', 1, 127, 1, 100, '', '')),
              num('kickDownbeat', '小節頭キックの強調', 0, 20, 1, 5, '', ''),
            ],
          },
          {
            group: 'スネア・リム',
            items: [
              num('snareVel', '音量（スネア）', 1, 127, 1, 104, '', ''),
              VEL_BASE(num('rimVel', '音量（リム・サイドスティック）', 1, 127, 1, 89, '', '')),
              bool('ghostNotes', '16分スネアをゴーストノート化', true, 'ゴーストノート：リズムを埋めるごく弱い打音'),
              when('ghostNotes', [true], num('ghostVel', 'ゴーストノートの強さ', 1, 80, 1, 34, '', '')),
            ],
          },
          {
            group: 'ハイハット・ライド',
            items: [
              VEL_BASE(num('hatVel', '音量（ハイハット・閉）', 1, 127, 1, 78, '', '')),
              VEL_BASE(num('hatPedalVel', '音量（ハイハット・ペダル）', 1, 127, 1, 78, '', '')),
              VEL_BASE(num('hatOpenVel', '音量（ハイハット・開）', 1, 127, 1, 84, '', '')),
              VEL_BASE(num('rideVel', '音量（ライド）', 1, 127, 1, 82, '', '')),
              num('hatAccent', 'ハイハット表拍の強調', 0, 30, 1, 8, '', 'ライドは6割、その他パーカッションにも同じ量をかける（下の2つも同じ）'),
              num('hatOffCut', 'ハイハット8分裏の減衰', 0, 40, 1, 10, '', ''),
              num('hat16Cut', 'ハイハット16分の減衰', 0, 50, 1, 18, '', ''),
            ],
          },
          {
            group: 'タム',
            items: [
              VEL_BASE(num('tomVel', '音量', 1, 127, 1, 98, '', 'ハイタム・ミッドタム・ロータム・フロアタムに共通')),
              num('fillCresc', 'タム回しのクレッシェンド幅', 0, 40, 1, 14, '', ''),
            ],
          },
          {
            group: 'クラッシュ',
            items: [
              VEL_BASE(num('cymbalVel', '音量', 1, 127, 1, 108, '', 'クラッシュ（右）・（左）に共通')),
            ],
          },
          {
            group: 'その他パーカッション',
            items: [
              VEL_BASE(num('percVel', '音量', 1, 127, 1, 80, '', 'ドラムマップで割り当てていない音（タンバリン・シェイカー等）。表拍の強調・裏拍の減衰はハイハットの値、揺れは「ハイハット・ライドの揺れ」を使う')),
            ],
          },
        ],
      },
      {
        group: 'タイミング',
        items: [
          beats('beatShift', '拍ごとのタメ・走り', {}, 'すべてのパーツのタイミングを拍ごとにずらす。▲＝拍頭のずれ、◆＝拍の途中のずれ（右へ動かすと拍の前半を溜めて後半で取り戻し、左へ動かすと前半を走って後半で戻る）。右＝遅らせる（タメ）、左＝早める（走り）。スイング（ハネ）は下の「スイング」で、ハネさせる音価（8分・16分）と裏の位置（50%＝イーブン、66.7%＝三連、75%＝付点。ダブルクリックでイーブンに戻す）を指定する。ドラッグで動かし、ダブルクリックで0に戻す。配置は1小節の拍数ごとに別々に持ち、開いている曲の拍子の分を表示する（6/8 は付点4分を1拍として2拍）。途中で拍子が変わる曲では、各小節の拍数の配置を使う'),
        ],
        groups: [
          {
            group: 'キック',
            items: [
              num('kickSd', 'キックの揺れ', 0, 30, 1, 3, 'ms', ''),
            ],
          },
          {
            group: 'スネア・リム',
            items: [
              num('snareSd', 'スネアの揺れ', 0, 30, 1, 4, 'ms', ''),
              num('snareLaybackMs', 'スネアのレイドバック', -15, 30, 1, 4, 'ms', 'レイドバック：拍よりわずかに後ろで叩き、落ち着いたノリを出す'),
              when('ghostNotes', [true], num('ghostSd', 'ゴーストノートの追加揺れ', 0, 30, 1, 6, 'ms', '')),
            ],
          },
          {
            group: 'ハイハット・ライド',
            items: [
              num('hatSd', 'ハイハット・ライドの揺れ', 0, 30, 1, 6, 'ms', 'その他パーカッションにも使う'),
              num('hatOffPushMs', 'ハイハット裏拍の前のめり', -15, 15, 1, -2, 'ms', '負の値で裏拍を早める。ライドにも使う'),
            ],
          },
          {
            group: 'タム',
            items: [
              num('tomSd', 'タムの揺れ', 0, 30, 1, 5, 'ms', ''),
            ],
          },
          {
            group: 'クラッシュ',
            items: [
              num('cymbalSd', 'クラッシュの揺れ', 0, 30, 1, 5, 'ms', ''),
            ],
          },
        ],
      },
    ],
  };

  // 正規化（ヒューマナイズの逆）の設定。group の無いグループは見出しを付けずに項目を並べ、groups は入れ子のグループ
  const NORMALIZE_SCHEMA = [
    {
      items: [
        select('minGrid', '最小音価', [['auto', '自動'], ['8', '8分'], ['16', '16分'], ['32', '32分']], 'auto', 'クオンタイズ（音の開始位置を拍の細かい区切りに揃えること）やノート長で使う最も細かい音符。この範囲で拍ごとに分割を判定する。曲に合わせて指定すると、細かすぎる誤判定が減る'),
      ],
    },
    {
      group: 'クオンタイズ',
      groups: [
        {
          group: 'ノートの開始位置',
          items: [
            bool('triplet', '3連を含む', true, '8分なら8分3連、16分・32分なら16分3連まで候補にする。3連のない曲ではオフにすると誤判定が減る'),
            select('swingGrid', 'スイングを取る', [['off', 'なし'], ['8', '8分'], ['16', '16分']], 'off', 'スイング（ハネ）している曲で、ハネた裏の音をまっすぐな位置へ戻してから揃える。8分＝8分の裏がハネている曲、16分＝16分の裏がハネている曲。ハネた8分が8分3連と判定されるのも防ぐ'),
            when('swingGrid', ['8', '16'], num('swingRatio', '元のスイング率', SWING_MIN, SWING_MAX, 0.1, 66.7, '%', '元の曲で裏の音が置かれている位置（50%＝イーブン、66.7%＝三連、75%＝付点）。小節頭から音価で数える')),
            num('startStrength', '寄せる強さ', 0, 1, 0.05, 1, '比', '1=完全に揃える。0.5なら半分だけ寄せる'),
            num('tempoFollow', 'テンポの揺れに追従', 0, 1, 0.05, 0.6, '比', '演奏のテンポの揺れを追いかけて、ファイルのテンポどおりに揃える。0=追従しない（クリックに合わせた演奏向け）。大きいほど細かい揺れまで追う'),
          ],
        },
        {
          group: 'ノート長',
          items: [
            select('endMode', '方式', [['nearest', '元の長さに最も近い長さ'], ['grid', '終了位置もグリッドに寄せる'], ['legato', '次の発音まで伸ばす'], ['fixed', '固定長'], ['keep', '元の長さを保つ']], 'nearest', '「元の長さに最も近い長さ」：最小音価の1倍・2倍…と伸ばしていき、加工前の長さに最も近いものにする（3連の位置で始まる音は3連の単位）'),
            when('endMode', ['fixed'], Object.assign(num('fixedGrids', '長さ', 1, 16, 1, 1, '', '最小音価の何倍の長さにするか。最小音価が自動なら、判定した音価が単位'), { prefix: '×' })),
            bool('cutOnChordChange', 'コードが変わる小節線で音を終える', true, 'ピアノ・ギターのみ。小節ごとにコードを判定し、前の小節の響きが残ると濁るコードに変わる小節線では、小節線をまたいで鳴っている音（ペダルを長さに反映した分も含む）をその小節線で終える。最低音だけが動く場合（C→C/E）や、前のコードの音が次のコードの構成音・テンション1音までに収まる場合（G→Em7、C→Am）は終えない'),
          ],
        },
      ],
    },
    {
      group: 'ベロシティ',
      items: [
        select('velMode', '揃え先', [['fixed', '指定値'], ['mean', '曲の平均値'], ['keep', '揃えない']], 'fixed', ''),
        when('velMode', ['fixed'], num('velValue', '指定値', 1, 127, 1, 100, '', '')),
        when('velMode', ['fixed', 'mean'], num('velStrength', '揃える強さ', 0, 1, 0.05, 1, '比', '1=全ノート同じ値。0.5なら差を半分に縮める')),
      ],
    },
    {
      group: 'CC',
      items: [
        select('pedalMode', 'サステインペダル (CC64)', [['bake', 'ノート長に反映してから削除'], ['remove', '削除のみ'], ['keep', '残す']], 'remove', '「反映」はペダルで伸びていた分をノートの長さに書き込む（一次データのノートが伸びるため、ピアノでは旋律の判定が崩れやすい）'),
        bool('removeExpression', 'CC1・CC11・CC4 を削除', true, 'モジュレーション・エクスプレッション・ハイハット開閉'),
      ],
    },
  ];

  /** 入れ子のグループも含めた全項目 */
  function itemsOf(schema) {
    return schema.flatMap((g) => [...(g.items || []), ...itemsOf(g.groups || [])]);
  }
  function defaultsOf(schema) {
    const out = {};
    // 波形の配列・拍ごとのずれは書き換えても既定値が変わらないよう複製する
    for (const it of itemsOf(schema)) out[it.key] = it.default && typeof it.default === 'object' ? JSON.parse(JSON.stringify(it.default)) : it.default;
    return out;
  }
  function defaultParams(instrument) {
    return defaultsOf(SCHEMA[instrument] || []);
  }

  // プリセットJSONの形式バージョン。v2 でピアノの手別統計 handStats（Phase 2 の解析結果。任意）を追加。v1 もそのまま読める
  const PRESET_VERSION = 2;
  const HAND_STAT_KEYS = ['notes', 'velMean', 'velSd', 'velArc', 'timingSdMs', 'leadMs', 'lengthRatio'];

  /** handStats: { R: {velMean, ...}, L: {...} } のうち、既知の数値項目だけを残す（不正なら null） */
  function parseHandStats(hs) {
    if (!hs || typeof hs !== 'object' || Array.isArray(hs)) return null;
    const out = {};
    for (const hand of ['R', 'L']) {
      const src = hs[hand];
      if (!src || typeof src !== 'object') continue;
      out[hand] = {};
      for (const key of HAND_STAT_KEYS) if (typeof src[key] === 'number' && isFinite(src[key])) out[hand][key] = src[key];
    }
    return Object.keys(out).length ? out : null;
  }

  /** 拍子の文字列（"3/4" など）を正規化する。不正なら null（＝拍子共通） */
  function parseMeter(v) {
    const m = typeof v === 'string' && /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(v);
    if (!m) return null;
    const num = Number(m[1]);
    const den = Number(m[2]);
    return num >= 1 && [1, 2, 4, 8, 16, 32].includes(den) ? `${num}/${den}` : null;
  }

  /** プリセットJSON（Phase 2 の解析結果も同形式）を検証して取り込む */
  function parsePresetJson(text) {
    return parsePresetObject(JSON.parse(text));
  }
  function parsePresetObject(obj) {
    const validInstrument = obj && Object.prototype.hasOwnProperty.call(SCHEMA, obj.instrument);
    const validParams = obj && obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params);
    if (!validInstrument || !validParams) throw new Error('プリセットの形式が不正です（instrument / params が必要）');
    if (typeof obj.version === 'number' && obj.version > PRESET_VERSION) throw new Error(`このプリセットは新しい形式です（version ${obj.version}）。ツールを更新してください`);
    const valid = new Map();
    for (const it of itemsOf(SCHEMA[obj.instrument])) valid.set(it.key, it);
    const params = {};
    for (const [key, v] of Object.entries(obj.params)) {
      const it = valid.get(key);
      if (!it) continue;
      if (it.type === 'number' && typeof v === 'number' && isFinite(v)) params[key] = Math.max(it.min, Math.min(it.max, v));
      else if (it.type === 'bool' && typeof v === 'boolean') params[key] = v;
      else if (it.type === 'select' && it.options.some((o) => o[0] === v)) params[key] = v;
      else if (it.type === 'wave' && Array.isArray(v) && v.length === it.points && v.every((x) => typeof x === 'number' && isFinite(x))) params[key] = v.map((x) => roundWave(Math.max(-1, Math.min(1, x))));
      else if (it.type === 'beats' && parseBeatShift(v)) params[key] = parseBeatShift(v);
      else if (it.type === 'strum' && parseStrumPattern(v)) params[key] = parseStrumPattern(v);
      else if (it.type === 'accentGrid' && parseAccentGrid(v)) params[key] = parseAccentGrid(v);
    }
    // 旧形式: 小節内の呼吸は型（breathShape）と強さ（breath）だった
    const op = obj.params;
    if (obj.instrument === 'piano' && !('beatShift' in params) && ('breathShape' in op || 'breath' in op)) {
      const scale = typeof op.breath === 'number' && isFinite(op.breath) ? Math.max(0, Math.min(3, op.breath)) : 1;
      params.beatShift = legacyBeatShift(op.breathShape, scale);
    }
    // 旧形式: ギターの強弱は「拍頭アクセント」（beatAccent）の強さだけだった
    if (obj.instrument === 'guitar' && !('strumPattern' in params) && typeof op.beatAccent === 'number' && isFinite(op.beatAccent)) {
      params.strumPattern = legacyStrumPattern(op.beatAccent);
    }
    // 旧形式: ピアノ・ドラムの既定の型の強さは項目（ピアノ beatAccent・ドラム patternAccent）だった。既定と違えば "*": { scale } にする
    const legacyScaleKey = { piano: 'beatAccent', drums: 'patternAccent' }[obj.instrument];
    const legacyScale = legacyScaleKey && op[legacyScaleKey];
    if (typeof legacyScale === 'number' && isFinite(legacyScale) && legacyScale !== ACCENT_SCALE[obj.instrument] && !(params.accentGrid && params.accentGrid['*'])) {
      params.accentGrid = Object.assign({ '*': { scale: Math.max(0, Math.min(STRUM_ACC_MAX, legacyScale)) } }, params.accentGrid);
    }
    // 旧形式: ドラムのリムはスネア −15、ハイハットはペダル・開も閉（hatVel）と共通（開だけ +6）だった
    if (obj.instrument === 'drums') {
      const legacy = (key, from, add) => {
        if (!(key in params) && from in params) params[key] = Math.max(1, Math.min(127, params[from] + add));
      };
      legacy('rimVel', 'snareVel', -15);
      legacy('hatPedalVel', 'hatVel', 0);
      legacy('hatOpenVel', 'hatVel', 6);
    }
    // 旧形式: CC1 のビブラートはチェックボックス（modulation）だった
    if (obj.instrument === 'guitar' && obj.params.modulation === true && !('vibrato' in params)) params.vibrato = 'cc1';
    const out = { instrument: obj.instrument, name: String(obj.name || '読み込んだプリセット').slice(0, 60), source: String(obj.source || 'file').slice(0, 40), params };
    const handStats = obj.instrument === 'piano' ? parseHandStats(obj.handStats) : null;
    if (handStats) out.handStats = handStats;
    const meter = parseMeter(obj.meter);
    if (meter) out.meter = meter;
    return out;
  }

  // 組み込みプリセット。実体は src/presets/<楽器>/<キー>.json（_bundle.js に生成して先に読み込む）。
  // 読込プリセットと同じ検証を通す。楽器ごとの先頭（キー default）が既定＝ Phase 2 の音源解析の統合プリセット
  function builtinPresets(data) {
    if (!data) console.error('組み込みプリセットがありません（presets/_bundle.js を js/presets.js より先に読み込む）');
    const out = {};
    for (const inst of Object.keys(SCHEMA)) {
      out[inst] = {};
      for (const [key, obj] of Object.entries((data && data[inst]) || {})) {
        // 1件が不正でもツール全体は止めない（その件だけ一覧から外す）
        try {
          const { name, params, handStats, meter } = parsePresetObject(obj);
          out[inst][key] = Object.assign({ name, params }, handStats && { handStats }, meter && { meter });
        } catch (e) {
          console.error(`組み込みプリセット ${inst}/${key}: ${e.message}`);
        }
      }
    }
    return out;
  }
  const PRESETS = builtinPresets(MH.BUILTIN_PRESET_DATA);

  MH.PARAM_SCHEMA = SCHEMA;
  MH.PRESETS = PRESETS;
  MH.NORMALIZE_SCHEMA = NORMALIZE_SCHEMA;
  MH.defaultsOf = defaultsOf;
  MH.defaultParams = defaultParams;
  MH.parsePresetJson = parsePresetJson;
  MH.parsePresetObject = parsePresetObject;
  MH.parseMeter = parseMeter;
  MH.PRESET_VERSION = PRESET_VERSION;
  MH.SINE_WAVE = SINE_WAVE;
  MH.roundWave = roundWave;
  MH.beatShiftOf = beatShiftOf;
  MH.beatShiftAt = beatShiftAt;
  MH.swingShift = swingShift;
  MH.swingUnshift = swingUnshift;
  MH.legacyBeatShift = legacyBeatShift;
  MH.LEGACY_BREATH = LEGACY_BREATH;
  MH.strumGrid = strumGrid;
  MH.strumPatternOf = strumPatternOf;
  MH.strumDirOf = strumDirOf;
  MH.strumArticOf = strumArticOf;
  MH.ARTICS = ARTICS;
  MH.strumSlotAt = strumSlotAt;
  MH.accentGridFill = accentGridFill;
  MH.strumAccentScale = strumAccentScale;
  MH.accentScale = accentScale;
  MH.ACCENT_SCALE = ACCENT_SCALE;
  MH.accentGridOf = accentGridOf;
  MH.accentGridAt = accentGridAt;
  MH.accentGridLevelAt = accentGridLevelAt;
  MH.strumAccentLevelAt = strumAccentLevelAt;
  MH.accentSdScale = accentSdScale;
  MH.defaultStrumPattern = defaultStrumPattern;
  MH.legacyStrumPattern = legacyStrumPattern;
  MH.legacyAccent = legacyAccent;
})(typeof window !== 'undefined' ? window : globalThis);
