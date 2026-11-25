/**
 * ドラムマップ: パーツ（キック・スネア等）→ 音の高さの一覧。
 * 音源によって割り当てが違うため、1パーツに複数の音の高さを割り当てられる（1つの音の高さは1パーツのみ）。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  // 詳細パーツ。type はパーツの種類（色分け・ヒューマナイズの扱いは種類ごと）
  const DRUM_PARTS = [
    { key: 'kick', label: 'キック（バスドラム）', type: 'kick' },
    { key: 'snare', label: 'スネア', type: 'snare' },
    { key: 'rim', label: 'リム・サイドスティック', type: 'rim' },
    { key: 'hatClosed', label: 'ハイハット（閉）', type: 'hat' },
    { key: 'hatPedal', label: 'ハイハット（ペダル）', type: 'hat' },
    { key: 'hatOpen', label: 'ハイハット（開）', type: 'hat' },
    { key: 'tomHigh', label: 'ハイタム', type: 'tom' },
    { key: 'tomMid', label: 'ミッドタム', type: 'tom' },
    { key: 'tomLow', label: 'ロータム', type: 'tom' },
    { key: 'tomFloor', label: 'フロアタム', type: 'tom' },
    { key: 'ride', label: 'ライド', type: 'ride' },
    { key: 'crashR', label: 'クラッシュ（右）', type: 'crash' },
    { key: 'crashL', label: 'クラッシュ（左）', type: 'crash' },
    { key: 'perc', label: 'その他パーカッション', type: 'perc' },
  ];
  // パーツの種類（ピアノロールの凡例の並び）
  const DRUM_TYPES = [
    { key: 'kick', label: 'キック' },
    { key: 'snare', label: 'スネア' },
    { key: 'rim', label: 'リム・サイドスティック' },
    { key: 'hat', label: 'ハイハット' },
    { key: 'tom', label: 'タム' },
    { key: 'ride', label: 'ライド' },
    { key: 'crash', label: 'クラッシュ' },
    { key: 'perc', label: 'その他パーカッション' },
  ];
  const PART_KEYS = new Set(DRUM_PARTS.map((p) => p.key));
  const TYPE_OF = new Map(DRUM_PARTS.map((p) => [p.key, p.type]));
  const LABEL_OF = new Map(DRUM_PARTS.map((p) => [p.key, p.label]));
  const TYPE_KEYS = new Set(DRUM_TYPES.map((t) => t.key));
  /** 詳細パーツ（または種類）の種類。不明なら 'perc' */
  const partType = (part) => TYPE_OF.get(part) || (TYPE_KEYS.has(part) ? part : 'perc');

  // 種類の色相（鍵盤・ピアノロールの色分け。同じ種類の詳細パーツは同じ色）。その他パーカッションは灰色
  const TYPE_HUE = { kick: 0, snare: 50, rim: 28, hat: 188, tom: 275, ride: 115, crash: 320, perc: null };
  /** パーツ（詳細パーツ・種類のどちらでも）の色。light は明るさ（%） */
  function partColor(part, light = 55, alpha = 1) {
    const hue = TYPE_HUE[partType(part)];
    return hue == null ? `hsla(0, 0%, ${light}%, ${alpha})` : `hsla(${hue}, 75%, ${light}%, ${alpha})`;
  }

  // GM 標準。チャイナ（52）・スプラッシュ（55）は割り当てない（その他パーカッション）
  const GM_DRUM_MAP = {
    kick: [35, 36],
    snare: [38, 40],
    rim: [37, 39],
    hatClosed: [42],
    hatPedal: [44],
    hatOpen: [46],
    tomHigh: [50],
    tomMid: [47, 48],
    tomLow: [45],
    tomFloor: [41, 43],
    ride: [51, 53, 59],
    crashR: [57],
    crashL: [49],
    perc: [],
  };

  const isHat = (part) => partType(part) === 'hat';

  /**
   * 旧形式（タム・クラッシュ等がそれぞれ1パーツ）のマップを詳細パーツに分ける。
   * タムは低い順に4等分してフロア→ロー→ミッド→ハイ（GM標準ならそのまま GM の割り当てになる）、クラッシュ等は 57 を右、それ以外を左
   */
  function upgradeLegacyMap(map) {
    if (!map || (!('tom' in map) && !('crash' in map))) return map;
    const out = Object.assign({}, map);
    const add = (key, p) => (out[key] = (Array.isArray(out[key]) ? out[key] : []).concat(p));
    const toms = (Array.isArray(map.tom) ? map.tom : []).filter(Number.isInteger).sort((a, b) => a - b);
    const TOMS = ['tomFloor', 'tomLow', 'tomMid', 'tomHigh'];
    toms.forEach((p, i) => add(TOMS[Math.floor((i * 4) / toms.length)], p));
    for (const p of Array.isArray(map.crash) ? map.crash : []) add(p === 57 ? 'crashR' : 'crashL', p);
    delete out.tom;
    delete out.crash;
    return out;
  }

  /** 全パーツのキーを持ち、音の高さが 0〜127 の整数で、1つの音の高さが1パーツだけに属するマップにする（旧形式は詳細パーツに分ける） */
  function cleanDrumMap(map) {
    map = upgradeLegacyMap(map);
    const out = {};
    const used = new Set();
    for (const { key } of DRUM_PARTS) {
      const list = Array.isArray(map && map[key]) ? map[key] : [];
      out[key] = [];
      for (const v of list) {
        if (!Number.isInteger(v) || v < 0 || v > 127 || used.has(v)) continue;
        used.add(v);
        out[key].push(v);
      }
      out[key].sort((a, b) => a - b);
    }
    return out;
  }

  /** @returns {(pitch:number) => string|null} 割り当てたパーツ（割り当ての無い音の高さは null） */
  function drumAssignment(map) {
    const partOf = new Map();
    const m = upgradeLegacyMap(map || GM_DRUM_MAP);
    for (const key of Object.keys(m)) if (PART_KEYS.has(key)) for (const p of m[key]) partOf.set(p, key);
    return (pitch) => partOf.get(pitch) || null;
  }

  /** @returns {(pitch:number) => string} 割り当ての無い音の高さは 'perc' */
  function drumPartResolver(map) {
    const assigned = drumAssignment(map);
    return (pitch) => assigned(pitch) || 'perc';
  }

  /**
   * 試聴で鳴らす GM 配列の音の高さ（マップのパーツの音で鳴らす）。
   * GM でも同じパーツの音の高さはそのまま（クラッシュ1・2 など、同じパーツ内の違いを残す）。
   * それ以外は、そのパーツに割り当てた音の高さの低い方から何番目かで、GM のそのパーツの音を選ぶ（1つ目は代表の音。タムは低い順）。
   * 割り当ての無い音の高さ・その他パーカッションはそのまま
   * @returns {(pitch:number) => number}
   */
  // パーツごとの GM の音の高さを、よく使う音から並べたもの（タムは低い順）
  const GM_SOUND_ORDER = { kick: [36, 35], snare: [38, 40], rim: [37, 39], tomMid: [48, 47], tomFloor: [43, 41], ride: [51, 59, 53] };
  // GM でクラッシュの仲間の音（チャイナ・スプラッシュ）。クラッシュに割り当てたときはそのまま鳴らす
  const GM_CYMBAL_EXTRA = [52, 55];
  function drumSoundPitch(map) {
    const partOf = drumAssignment(map);
    const m = upgradeLegacyMap(map || GM_DRUM_MAP);
    return (pitch) => {
      const part = partOf(pitch);
      if (!part || GM_DRUM_MAP[part].includes(pitch) || (partType(part) === 'crash' && GM_CYMBAL_EXTRA.includes(pitch))) return pitch;
      const gm = GM_SOUND_ORDER[part] || GM_DRUM_MAP[part];
      if (!gm.length) return pitch;
      const i = m[part].slice().sort((a, b) => a - b).indexOf(pitch);
      return gm[Math.min(Math.max(0, i), gm.length - 1)];
    };
  }

  /** pitch を part に割り当てる（他パーツからは外す）。part が null なら割り当てを外す */
  function assignPitch(map, pitch, part) {
    const out = {};
    for (const key of Object.keys(map)) out[key] = map[key].filter((p) => p !== pitch);
    if (part) out[part] = out[part].concat(pitch).sort((a, b) => a - b);
    return out;
  }

  /** ドラムマップJSON `{version, type:'drumMap', name, map}` を検証して取り込む */
  function parseDrumMapJson(text) {
    const obj = JSON.parse(text);
    if (!obj || obj.type !== 'drumMap' || !obj.map || typeof obj.map !== 'object' || Array.isArray(obj.map)) {
      throw new Error('ドラムマップの形式が不正です（type: "drumMap" と map が必要）');
    }
    return { name: String(obj.name || '読み込んだマップ').slice(0, 60), map: cleanDrumMap(obj.map) };
  }

  function drumMapToJson(name, map) {
    return { version: 2, type: 'drumMap', name, map: cleanDrumMap(map) };
  }

  MH.DRUM_PARTS = DRUM_PARTS;
  MH.DRUM_TYPES = DRUM_TYPES;
  MH.drumPartType = partType;
  MH.drumPartLabel = (part) => LABEL_OF.get(part) || null;
  MH.GM_DRUM_MAP = GM_DRUM_MAP;
  MH.isHatPart = isHat;
  MH.cleanDrumMap = cleanDrumMap;
  MH.drumPartResolver = drumPartResolver;
  MH.drumAssignment = drumAssignment;
  MH.drumSoundPitch = drumSoundPitch;
  MH.drumPartColor = partColor;
  MH.assignDrumPitch = assignPitch;
  MH.parseDrumMapJson = parseDrumMapJson;
  MH.drumMapToJson = drumMapToJson;
})(typeof window !== 'undefined' ? window : globalThis);
