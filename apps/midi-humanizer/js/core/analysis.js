/**
 * 楽曲構造の簡易解析：同時発音（クラスタ）とフレーズの検出。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  // Math.min(...arr) は大きな配列でスタックが溢れるため reduce で求める
  const minOf = (arr, f) => arr.reduce((m, x) => Math.min(m, f(x)), Infinity);
  const maxOf = (arr, f) => arr.reduce((m, x) => Math.max(m, f(x)), -Infinity);

  /** 開始位置がほぼ同じノートを1つのクラスタ（和音・同時打鍵）にまとめる */
  function clusterOnsets(notes, tolTicks) {
    const sorted = notes.slice().sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    const clusters = [];
    for (const n of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && n.tick - last.tick <= tolTicks) last.notes.push(n);
      else clusters.push({ tick: n.tick, notes: [n] });
    }
    for (const c of clusters) c.notes.sort((a, b) => a.pitch - b.pitch);
    return clusters;
  }

  /** クラスタの元のMIDI上の開始位置（正規化前。無ければ今の位置） */
  const srcTickOf = (c) => minOf(c.notes, (n) => n.srcTick ?? n.tick);

  /**
   * クラスタ列をフレーズに分割し、各クラスタに phraseIndex / phrasePos(0..1) / isPhraseStart / isPhraseEnd を付与する。
   * 区切り: 前の音が鳴り終わってから gapTicks 以上の休符、または maxBars 小節を超えたとき。
   * starts（元のMIDI上の位置。srcTick）を渡すと休符・小節数では判定せず、その位置で区切る（各位置以降の最初のクラスタからフレーズを始める）。
   * 各フレーズには、最初のクラスタの元のMIDI上の位置 srcStart を付ける（区切りを覚えておき、次から starts として渡すため）
   * @param {{gapTicks:number, maxBars:number, starts?:number[]|null}} opts
   */
  function detectPhrases(clusters, maps, opts) {
    const gapTicks = opts.gapTicks;
    const maxBars = Math.max(1, opts.maxBars | 0);
    const starts = opts.starts ? opts.starts.slice().sort((a, b) => a - b) : null;
    const phrases = [];
    let cur = null;
    let maxEnd = -Infinity;
    let si = 0; // starts のうち、まだ越えていない最初の位置
    for (const c of clusters) {
      const pos = maps.position(c.tick);
      const cEnd = maxOf(c.notes, (n) => n.endTick);
      const src = srcTickOf(c);
      let split;
      if (starts) {
        split = false;
        for (; si < starts.length && starts[si] <= src; si++) split = true;
      } else split = !!cur && (c.tick - maxEnd >= gapTicks || pos.bar - cur.startBar >= maxBars);
      if (!cur || split) {
        cur = { startTick: c.tick, startBar: pos.bar, srcStart: src, clusters: [] };
        phrases.push(cur);
      }
      cur.clusters.push(c);
      maxEnd = Math.max(maxEnd, cEnd);
    }
    phrases.forEach((ph, pi) => {
      const first = ph.clusters[0].tick;
      const last = ph.clusters[ph.clusters.length - 1].tick;
      ph.lastOnset = last;
      ph.endTick = maxOf(ph.clusters[ph.clusters.length - 1].notes, (n) => n.endTick);
      ph.clusters.forEach((c, i) => {
        c.phraseIndex = pi;
        c.phrasePos = last > first ? (c.tick - first) / (last - first) : 0.5;
        c.isPhraseStart = i === 0;
        c.isPhraseEnd = i === ph.clusters.length - 1;
      });
    });
    return phrases;
  }

  /** tick がどのフレーズのどの位置か（フレーズ外は最寄りのフレーズで代用） */
  function phrasePosAt(phrases, tick) {
    if (!phrases.length) return 0.5;
    let lo = 0;
    let hi = phrases.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (phrases[mid].startTick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const best = phrases[lo];
    const span = Math.max(1, best.endTick - best.startTick);
    return Math.max(0, Math.min(1, (tick - best.startTick) / span));
  }

  /**
   * フレーズ内の山なりカーブ（0..1）。頭は0から始まり peak で1、末尾に向けて下がる。
   * 「フレーズ頭はppから再開しcrescendo」の型を表現する。
   */
  function phraseArc(pos, peak) {
    const pk = Math.max(0.05, Math.min(0.95, peak == null ? 0.65 : peak));
    if (pos <= pk) return Math.sin((Math.PI / 2) * (pos / pk));
    return 0.35 + 0.65 * Math.cos((Math.PI / 2) * ((pos - pk) / (1 - pk)));
  }

  /** 区分線形補間 */
  function interp(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
      }
    }
    return points[points.length - 1][1];
  }

  MH.minOf = minOf;
  MH.maxOf = maxOf;
  MH.clusterOnsets = clusterOnsets;
  MH.detectPhrases = detectPhrases;
  MH.phrasePosAt = phrasePosAt;
  MH.phraseArc = phraseArc;
  MH.interp = interp;
})(typeof window !== 'undefined' ? window : globalThis);
