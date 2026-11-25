/**
 * ギターのストローク方向・ミュート奏法の推定（strumMode 'smart'）。
 *  - 右手は止まらず ↓↑ と振り続ける（振り子）。グリッドの偶数マス＝ダウン、奇数マス＝アップを基本とし、
 *    和音ごとの手がかり（拍の強さ・ベロシティ・長さ・ボイシング・発音順）で「ダウンらしさ」の点数を出す
 *  - 間隔が短い和音どうしが同じ方向になる並びは、手の往復が間に合わないので減点する。
 *    和音の並び全体で点数が最も良い方向の並びを DP（ビタビ法）で選ぶ
 *  - グリッドの単位（8分／16分）は小節ごと（前後1小節に16分の裏の和音があれば16分）。複合拍子は常に8分
 *  - 手がかりは元のMIDIの値（srcVel・srcTick）を使う。正規化してからヒューマナイズしても失われない
 *  - ミュート奏法: 低い音域で短く切った音が続く部分をパームミュート、裏で短く弱い和音をブラッシングと推定する
 *  - 強拍（強拍のパターン strumStrongPattern でプラスのマスの和音）は方向をダウン寄りにする（奏法を通常にするのは guitar.js）
 *  - 強拍の型（ACCENT_PATTERNS）: 強弱のパターンの「型を呼び出す」に使う型の一覧
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const median = (a) => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[s.length >> 1];
  };
  const endOf = (n) => n.keyEnd ?? n.endTick;

  // パームミュートとみなす最低音の上限（E3。6・5弦のパワーコード・刻み）と、連続して必要な数
  const PM_MAX_LOW = 52;
  const PM_RUN = 3;

  // ---------- 強拍の型 ----------
  // grid: span（bars 小節）を等分する数、at: 強拍のマス（16分のマスに乗る位置だけ）。meters: 使える拍子（省略はすべて）。
  // 'beats'・'downbeat' は拍子ごとに作る（beatsGrid）。4/4 用の型は 2/2 にも使う
  const FOUR = ['4/4', '2/2'];
  const ACCENT_PATTERNS = [
    { id: 'beats', label: '拍ごと（4分×4・3/4 の4分×3・6/8 の付点4分×2）' },
    { id: 'downbeat', label: '小節頭だけ（ワルツ・全音符）' },
    { id: 'half', label: '2分×2（1・3拍）', meters: FOUR, grid: 8, at: [0, 4] },
    { id: '332', label: '3-3-2（付点4分×2＋4分）', meters: FOUR, grid: 8, at: [0, 3, 6] },
    { id: '233', label: '2-3-3（4分＋付点4分×2）', meters: FOUR, grid: 8, at: [0, 2, 5] },
    { id: 'charleston', label: 'チャールストン（付点4分＋8分〜）', meters: FOUR, grid: 8, at: [0, 3] },
    { id: 'backbeat', label: 'バックビート（2・4拍）', meters: FOUR, grid: 8, at: [2, 6] },
    { id: 'offbeat', label: '裏拍（レゲエ・スカ）', meters: FOUR, grid: 8, at: [1, 3, 5, 7] },
    { id: '332x16', label: '16分の3-3-2（半小節ごと）', meters: FOUR, grid: 16, at: [0, 3, 6, 8, 11, 14] },
    { id: '333322', label: '3-3-3-3-2-2（16分）', meters: FOUR, grid: 16, at: [0, 3, 6, 9, 12, 14] },
    { id: 'son32', label: 'ソン・クラーベ 3-2（2小節）', meters: FOUR, bars: 2, grid: 16, at: [0, 3, 6, 10, 12] },
    { id: 'son23', label: 'ソン・クラーベ 2-3（2小節）', meters: FOUR, bars: 2, grid: 16, at: [2, 4, 8, 11, 14] },
    { id: 'bossa', label: 'ボサノバ 3-3-4-3-3（2小節）', meters: FOUR, bars: 2, grid: 16, at: [0, 3, 6, 10, 13] },
    { id: 'hemiola', label: 'ヘミオラ（3/4 の2小節を2分×3）', meters: ['3/4'], bars: 2, grid: 12, at: [0, 4, 8] },
  ];

  /** 拍子 pos（maps.position の値）で使う型の grid・at（使えなければ null） */
  function patternGrid(pt, pos) {
    if (pt.id === 'beats' || pt.id === 'downbeat') {
      const sub = pos.compound ? 3 : 2; // 8分ごとのマス
      const grid = pos.pulses * sub;
      return { bars: 1, grid, at: pt.id === 'beats' ? Array.from({ length: pos.pulses }, (_, i) => i * sub) : [0] };
    }
    if (pt.meters && !pt.meters.includes(pos.meter)) return null;
    return { bars: pt.bars || 1, grid: pt.grid, at: pt.at };
  }

  /**
   * @param {{tick:number, notes:object[]}[]} clusters 同時発音（clusterOnsets の結果。音の高さ順）
   * @param {object} maps buildTimeMaps の結果
   * @param {object} p ギターのパラメータ（estBeat・estVel・estLen・estVoicing・estOrder・estFlow）
   * @param {boolean[]} [strong] 強拍に当たる同時発音（強拍のパターンでプラスのマスの和音）。強拍は裏のマスでも拍頭と同じくダウン寄りにする
   * @returns {{dir:'D'|'U'|null, artic:'P'|null, brush:boolean, score:number}[]} clusters と同じ順。dir は2音以上の和音だけ。
   *   artic はパームミュートと推定したときだけ 'P'。brush はブラッシングの候補（アップのときだけ × にする。方向は呼び出し側で確定するため）
   */
  function estimateStrums(clusters, maps, p, strong) {
    const ppq = maps.ppq;
    const out = clusters.map(() => ({ dir: null, artic: null, brush: false, score: 0 }));
    // 長さ・間隔は今の位置（正規化後なら正規化した長さ）で見る。強さ・発音順だけ元のMIDIの値を使う
    const info = clusters.map((c, i) => {
      const pos = maps.position(c.tick);
      const next = clusters[i + 1];
      const len = Math.max(...c.notes.map((n) => endOf(n) - n.tick));
      const ioi = next ? next.tick - c.tick : Infinity;
      return {
        idx: i,
        c,
        pos,
        chord: c.notes.length >= 2,
        vel: mean(c.notes.map((n) => n.srcVel ?? n.vel)),
        len,
        ioi,
        low: c.notes[0].pitch,
        count: c.notes.length,
        ms: maps.tickToMs(c.tick),
      };
    });

    // --- 小節ごとのグリッドの単位: 前後1小節に16分の裏（16分の奇数マス）の和音があれば16分 ---
    const odd16Bars = new Set();
    for (const x of info) {
      if (!x.chord || x.pos.compound) continue;
      const unit = x.pos.pulseTicks / 4;
      const posInBeat = x.pos.posInBar - x.pos.beat * x.pos.pulseTicks;
      const q = Math.round(posInBeat / unit);
      if (q % 2 === 1 && Math.abs(posInBeat - q * unit) <= unit / 4) odd16Bars.add(x.pos.bar);
    }
    const use16 = (bar) => odd16Bars.has(bar - 1) || odd16Bars.has(bar) || odd16Bars.has(bar + 1);

    const chords = info.filter((x) => x.chord);
    // 近くの和音（前後2小節）の平均・ばらつきと比べる（曲全体の強弱・音色の変化に引きずられないように）
    // chords は位置の順なので、範囲の両端を二分探索で求める
    const lowerBound = (tick) => {
      let lo = 0;
      let hi = chords.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (chords[mid].c.tick < tick) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const near = (x) => chords.slice(lowerBound(x.c.tick - x.pos.barTicks * 2), lowerBound(x.c.tick + x.pos.barTicks * 2 + 1));

    for (const x of chords) {
      const pos = x.pos;
      const gridTicks = pos.compound ? pos.pulseTicks / 3 : pos.pulseTicks / (use16(pos.bar) ? 4 : 2);
      // 拍の位置: 偶数マス＝ダウン（拍頭は強く、それ以外の偶数マスは弱め）、奇数マス＝アップ。
      // 複合拍子は付点4分の拍ごとに数え直す（拍頭＝ダウン。6/8 なら ↓↑↓ ↓↑↓）
      const pulseStart = Math.floor((pos.posInBar + gridTicks / 2) / pos.pulseTicks) * pos.pulseTicks; // 拍の少し前に鳴った音もその拍とみなす
      const k = Math.round((pos.compound ? pos.posInBar - pulseStart : pos.posInBar) / gridTicks);
      const onBeat = Math.abs(pos.posInBar - Math.round(pos.posInBar / pos.pulseTicks) * pos.pulseTicks) <= gridTicks / 4;
      const fBeat = (strong && strong[x.idx]) || (k % 2 === 0 && onBeat) ? 1 : k % 2 === 0 ? 0.7 : -1;
      const nb = near(x);
      // ベロシティ: 近くの和音より強ければダウン（ばらつきが小さい曲では効きにくい）
      const vs = nb.map((y) => y.vel);
      const vm = mean(vs);
      const vsd = Math.sqrt(mean(vs.map((v) => (v - vm) ** 2)));
      x.velZ = clamp((x.vel - vm) / Math.max(vsd, 8), -2, 2) / 2;
      // 長さ: 近くの和音より長く伸ばすほどダウン（2倍で +1）
      const fLen = clamp(Math.log2(Math.max(1, x.len)) - median(nb.map((y) => Math.log2(Math.max(1, y.len)))), -1, 1);
      // ボイシング: 弦の数が多い・低音弦を含むほどダウン（アップは高音弦だけを掻きやすい）
      const fCount = clamp((x.count - mean(nb.map((y) => y.count))) / 1.5, -1, 1);
      const fLow = clamp((mean(nb.map((y) => y.low)) - x.low) / 5, -1, 1);
      const fVoicing = (fCount + fLow) / 2;
      // 発音順（元のMIDIで弦ごとにずれている場合）: 低音が先ならダウン、高音が先ならアップ。
      // 同時発音とみなす幅（ppq/48。guitar.js の clusterOnsets）いっぱいのずれで最大
      const ts = x.c.notes.map((n) => n.srcTick ?? n.tick);
      const im = (ts.length - 1) / 2;
      const tm = mean(ts);
      let num = 0;
      let den = 0;
      ts.forEach((t, i) => {
        num += (i - im) * (t - tm);
        den += (i - im) ** 2;
      });
      const spread = den ? (num / den) * (ts.length - 1) : 0;
      const fOrder = Math.abs(spread) < 1 ? 0 : clamp(spread / Math.max(1, ppq / 48), -1, 1);
      x.score = p.estBeat * fBeat + p.estVel * x.velZ + p.estLen * fLen + p.estVoicing * fVoicing + p.estOrder * fOrder;
    }

    // --- DP（ビタビ法）: 点数に沿う方向ほど良く、間隔が短いのに同じ方向が続くと減点 ---
    // 同じ方向の減点は、間隔 250ms 以上で0、100ms 以下で最大（estFlow×2）
    const sameCost = (gapMs) => p.estFlow * 2 * clamp((250 - gapMs) / 150, 0, 1);
    const emit = (x, d) => (d === 0 ? -x.score : x.score); // 0=ダウン, 1=アップ
    const cost = [];
    const back = [];
    chords.forEach((x, i) => {
      if (!i) {
        cost.push([emit(x, 0), emit(x, 1)]);
        back.push([0, 1]);
        return;
      }
      const prev = cost[i - 1];
      const same = sameCost(x.ms - chords[i - 1].ms);
      const row = [];
      const from = [];
      for (const d of [0, 1]) {
        const stay = prev[d] + same;
        const flip = prev[1 - d];
        from.push(stay < flip ? d : 1 - d);
        row.push(Math.min(stay, flip) + emit(x, d));
      }
      cost.push(row);
      back.push(from);
    });
    if (chords.length) {
      let d = cost[cost.length - 1][0] <= cost[cost.length - 1][1] ? 0 : 1;
      for (let i = chords.length - 1; i >= 0; i--) {
        const idx = chords[i].idx;
        out[idx].dir = d === 0 ? 'D' : 'U';
        out[idx].score = chords[i].score;
        d = back[i][d];
      }
    }

    // --- ミュート奏法 ---
    {
      // 短く切った音（次の音までの間隔の6割以下）が低い音域で PM_RUN 回以上続く部分 = パームミュート（単音の刻みも含む）。
      // 刻みの中のアクセントで途切れないよう、強さは1音ずつではなく続く部分全体（和音の平均）で見る
      const cut = (x) => x.ioi !== Infinity && x.ioi <= ppq && x.len <= x.ioi * 0.6;
      const pmLike = info.map((x) => cut(x) && x.low <= PM_MAX_LOW);
      for (let i = 0; i < info.length; ) {
        if (!pmLike[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < info.length && pmLike[j + 1] && Math.abs(info[j + 1].low - info[i].low) <= 7) j++;
        // 刻みの最後の音は次の音までの間隔が空くことがあるので、直後の短い音も含める
        if (j + 1 < info.length && info[j + 1].low <= PM_MAX_LOW && Math.abs(info[j + 1].low - info[i].low) <= 7 && info[j + 1].len <= info[j].ioi * 0.6) j++;
        const zs = info.slice(i, j + 1).filter((x) => x.velZ != null).map((x) => x.velZ);
        if (j - i + 1 >= PM_RUN && mean(zs) <= 0.5) for (let t = i; t <= j; t++) out[t].artic = 'P';
        i = j + 1;
      }
      // ごく短く（間隔の35%以下）近くより弱い和音 = ブラッシングの候補（アップに決まった和音だけ × にする。guitar.js）
      for (const x of chords) {
        if (!out[x.idx].artic && cut(x) && x.len <= x.ioi * 0.35 && x.velZ <= -0.25) out[x.idx].brush = true;
      }
    }
    return out;
  }

  Object.assign(MH, { estimateStrums, ACCENT_PATTERNS, accentPatternGrid: patternGrid });
})(typeof window !== 'undefined' ? window : globalThis);
