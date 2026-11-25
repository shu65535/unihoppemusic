/**
 * 小節ごとのコード（和音名）の判定と、コードの変わり目で響きを切る必要があるかの判定。
 * 1小節に1コード。判定できない小節（音が無い・どの型にも合わない）は null。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  // コードの型。iv=構成音（ルートからの半音数）、tens=前後のコードの音として重なっても濁らない音（テンション）
  const QUALITIES = [
    { name: '', iv: [0, 4, 7], tens: [2, 9, 11] }, // 9th・13th・M7
    { name: 'm', iv: [0, 3, 7], tens: [2, 5, 10] }, // 9th・11th・m7
    { name: 'dim', iv: [0, 3, 6], tens: [] },
    { name: 'aug', iv: [0, 4, 8], tens: [] },
    { name: 'sus2', iv: [0, 2, 7], tens: [5, 9, 10] },
    { name: 'sus4', iv: [0, 5, 7], tens: [2, 9, 10] },
    { name: '6', iv: [0, 4, 7, 9], tens: [2, 11] },
    { name: 'm6', iv: [0, 3, 7, 9], tens: [2, 5] },
    { name: '7', iv: [0, 4, 7, 10], tens: [2, 9] },
    { name: 'M7', iv: [0, 4, 7, 11], tens: [2, 9] },
    { name: 'm7', iv: [0, 3, 7, 10], tens: [2, 5] },
    { name: 'm7b5', iv: [0, 3, 6, 10], tens: [5] },
    { name: 'dim7', iv: [0, 3, 6, 9], tens: [] },
    { name: 'add9', iv: [0, 2, 4, 7], tens: [9, 11] },
  ];

  const pcsOf = (rootPc, ivs) => ivs.map((i) => (rootPc + i) % 12);

  /** 音名ごとの重み（合計1）から最も合うコードを選ぶ。合わなければ null */
  function matchChord(w, bassPc) {
    const max = Math.max(...w);
    if (!(max > 0)) return null;
    let best = null;
    for (let r = 0; r < 12; r++) {
      for (const q of QUALITIES) {
        const pcs = pcsOf(r, q.iv);
        let inside = 0;
        let missing = 0;
        for (const pc of pcs) {
          inside += w[pc];
          if (w[pc] < max * 0.15) missing++; // わずかに残っているだけの音は構成音とみなさない
        }
        // 構成音で説明できる量 − 説明できない量 − 鳴っていない構成音 − 4和音（複雑な方）を少し不利に
        let score = inside - (1 - inside) - 0.35 * missing - 0.03 * (pcs.length - 3);
        if (r === bassPc) score += 0.12;
        if (!best || score > best.score) best = { score, root: r, q, pcs };
      }
    }
    if (best.score < 0.2) return null;
    const bass = bassPc != null && best.pcs.includes(bassPc) ? bassPc : best.root;
    const name = NAMES[best.root] + best.q.name + (bass !== best.root ? '/' + NAMES[bass] : '');
    return { root: best.root, quality: best.q.name, bass, name, pcs: best.pcs, tens: pcsOf(best.root, best.q.tens) };
  }

  /**
   * 小節ごとのコードを判定する。
   * notes の開始・終了は endOf(n)（既定は keyEnd ?? endTick。ペダルで伸びた分は前の小節の響きなので数えない）。
   * 戻り値: [{ bar, startTick, endTick, chord }]（chord は matchChord の戻り値か null）
   */
  function detectBarChords(notes, maps, opts) {
    const o = opts || {};
    const startOf = o.startOf || ((n) => n.tick);
    const endOf = o.endOf || ((n) => n.keyEnd ?? n.endTick);
    if (!notes.length) return [];
    const first = MH.minOf(notes, startOf);
    const last = MH.maxOf(notes, startOf);
    const near = maps.ppq / 8; // 小節頭とみなす幅（32分音符）。わずかに早く弾いた小節頭の音はその小節の音とする
    const bars = [];
    let pos = maps.position(first + near);
    // 小節の番号は pedalChangeTicks 側と同じく near を足した位置で求める（端数の小節長の丸め対策）
    for (let t = pos.barStartTick; t <= last + near; ) {
      pos = maps.position(t + near);
      const end = pos.barStartTick + pos.barTicks;
      bars.push({ bar: pos.bar, startTick: pos.barStartTick, endTick: end, pulseTicks: pos.pulseTicks });
      t = end > t ? end : t + pos.barTicks;
    }
    for (const b of bars) {
      const w = new Array(12).fill(0);
      let bassPitch = Infinity;
      let lowest = Infinity;
      let lowestCarried = Infinity;
      for (const n of notes) {
        const s = Math.max(startOf(n), b.startTick);
        const e = Math.min(endOf(n), b.endTick);
        if (e <= s || startOf(n) >= b.endTick - near) continue; // 次の小節頭をわずかに早く弾いた音は次の小節で数える
        // 前の小節から伸びている音は前のコードの響きなので軽く数える（次のコードを取り違えないため）
        const carried = startOf(n) < b.startTick - near;
        // 短い音（半拍未満）は経過音のことが多いので軽く数える
        const len = endOf(n) - startOf(n);
        // ベロシティは数えない（加工中の値で判定がシードによって変わらないように）
        const weight = (e - s) * (carried ? 0.3 : 1) * (len < b.pulseTicks / 2 ? 0.5 : 1);
        w[n.pitch % 12] += weight;
        if (carried) {
          lowestCarried = Math.min(lowestCarried, n.pitch);
          continue;
        }
        lowest = Math.min(lowest, n.pitch);
        if (e - s >= b.pulseTicks) bassPitch = Math.min(bassPitch, n.pitch);
      }
      // 最低音は小節内で弾いた音から選ぶ（伸びている音だけの小節はその音）
      if (bassPitch === Infinity) bassPitch = lowest !== Infinity ? lowest : lowestCarried;
      // 最低音（ベース）は和声の土台なので重く数える
      if (bassPitch !== Infinity) {
        const total = w.reduce((a, x) => a + x, 0);
        w[bassPitch % 12] += total * 0.15;
      }
      const sum = w.reduce((a, x) => a + x, 0);
      // 音名が2種類未満（単音の旋律など）はコードとみなさない
      b.chord = w.filter((x) => x > 0).length >= 2 ? matchChord(w.map((x) => x / sum), bassPitch === Infinity ? null : bassPitch % 12) : null;
    }
    return bars;
  }

  /**
   * 前のコードの響きを残したまま次のコードへ移っても濁らないか。
   * 2つのコードの音を合わせたものが、どちらかのコードの構成音に「使えるテンション1音まで」を足した範囲に収まれば濁らない
   * （例: G→Em7、C→Am、C→C/B）。最低音だけが動く場合（C→C/E）も構成音が同じなので濁らない。
   * どちらかが判定できない（null）ときは判断しない（true）。
   */
  function chordsCompatible(a, b) {
    if (!a || !b) return true;
    const union = new Set([...a.pcs, ...b.pcs]);
    const fits = (c) => {
      const extra = [...union].filter((pc) => !c.pcs.includes(pc));
      return extra.length <= 1 && extra.every((pc) => c.tens.includes(pc));
    };
    return fits(a) || fits(b);
  }

  /** コードが変わり、響きを切る必要がある小節の番号（直前の判定できた小節のコードと比べる） */
  function chordCutBars(bars) {
    const out = new Set();
    let prev = null;
    for (const b of bars) {
      if (!b.chord) continue;
      if (prev && !chordsCompatible(prev, b.chord)) out.add(b.bar);
      prev = b.chord;
    }
    return out;
  }

  MH.CHORD_NAMES = NAMES;
  MH.matchChord = matchChord;
  MH.detectBarChords = detectBarChords;
  MH.chordsCompatible = chordsCompatible;
  MH.chordCutBars = chordCutBars;
})(typeof window !== 'undefined' ? window : globalThis);
