/**
 * ピアノ用ヒューマナイザー。
 * 根拠（様式ベース）: 劇伴系ピアノ書法の分析
 *  - 左手（伴奏）は弱く一定・右手の旋律だけ幅を持つ（左右非対称の強弱）。左手/右手の判定は core/hands.js（分析段 core/analyze.js で行い、ctx.analysis で受け取る）
 *  - オスティナート（反復伴奏）は正確、旋律だけルバート（ランダムな揺れ。拍ごとのタメ・走りは両手共通）
 *  - 強拍・弱拍: 強弱のパターン（accentGrid。2小節）のマスの値を足す。強拍度（MH.accentGridLevelAt）でベロシティのランダム幅も変える（タイミング・長さには効かない）
 *  - 拍ごとのタメ・走り（beatShift。拍頭のずれ・拍の途中の膨らみ・8分・16分のスイングとも両手）
 *  - フレーズ頭は弱く始めてcrescendo、末尾で微小なrit
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  /** 位置（maps.position の戻り値）での拍ごとのずれ(ms)。値の無い拍数は0 */
  function beatShiftAt(value, pos) {
    return MH.beatShiftAt(MH.beatShiftOf(value, pos.pulses), pos.posInBar / pos.pulseTicks);
  }

  /** ペダルを踏み替える候補の位置（from より後、to 以下の小節線。拍子の変更に対応） */
  function pedalChangeTicks(maps, from, to) {
    const out = [];
    let pos = maps.position(from);
    for (let t = pos.barStartTick + pos.barTicks; t <= to; ) {
      out.push(t);
      pos = maps.position(t);
      const next = pos.barStartTick + pos.barTicks;
      t = next > t ? next : t + pos.barTicks; // 小節長が端数で同じ小節と判定されても必ず進める
    }
    return out;
  }

  function humanizePiano(notes, ctx, p) {
    const { maps, rng, k, ppq } = ctx;
    const ms = (tick, v) => maps.msToTicks(tick, v);
    const j = (sd) => rng.gauss(sd * k);
    const tol = Math.max(1, ppq / 48);
    const clusters = MH.clusterOnsets(notes, tol);

    // --- 左手/右手（ユーザー指定 > パート指定 > 分析した手。推定は分析段 core/analyze.js で済ませている） ---
    const hands = ctx.hands || {};
    MH.applyHands(notes, { parts: hands.parts, overrides: hands.overrides, fixed: ctx.analysis.hands });

    // --- 手の中の役割（旋律・内声・伴奏）と、フレーズ（分析した区切り。旋律がなければ全体で） ---
    const melodyWrappers = MH.pianoRoles(clusters, tol);
    const phraseSrc = melodyWrappers.length ? melodyWrappers : clusters;
    const phrases = MH.detectPhrases(phraseSrc, maps, MH.phraseOptsOf(p, ppq, ctx.phrases));
    for (const w of melodyWrappers) {
      Object.assign(w.notes[0], { phrasePos: w.phrasePos, isPhraseStart: w.isPhraseStart, isPhraseEnd: w.isPhraseEnd });
    }

    // --- ベロシティ・開始位置 ---
    for (const c of clusters) {
      const pos = maps.position(c.tick);
      const accent = MH.accentGridAt(p.accentGrid, pos, MH.ACCENT_SCALE.piano) * p.accentVelDepth; // 強拍・弱拍
      const lv = MH.accentGridLevelAt(p.accentGrid, pos, MH.ACCENT_SCALE.piano); // 強拍度（-1〜+1）
      const velSd = MH.accentSdScale(lv, p.accentVelSdDiff);
      // 拍ごとのタメ・走りとスイングは両手にかける（片手だけずらすと噛み合わないため）
      const shiftOff = beatShiftAt(p.beatShift, pos) * k;
      const swingTicks = Math.round(MH.swingShift(MH.beatShiftOf(p.beatShift, pos.pulses), pos.posInBar / ppq) * ppq * k);
      for (const n of c.notes) n.swingTicks = swingTicks;
      const accomp = c.notes.filter((n) => n.role === 'accomp');
      const accArc = MH.phraseArc(MH.phrasePosAt(phrases, c.tick), p.arcPeak);
      const accompOff = shiftOff + j(p.accompTimingSd);
      accomp.forEach((n, i) => {
        n.arcVel = p.accompVelArc * (accArc - 0.5); // 抑揚（自動）の分。抑揚のレーンを描いたときは pipeline で差し替える
        let v = p.accompVelBase + n.arcVel + accent * 0.6 + j(p.velJitter * 0.7 * velSd);
        if (accomp.length > 1) v += i === 0 ? p.bassBoost : -1.5;
        n.vel = v;
        n.velRef = p.accompVelBase; // ベロシティ基準「相対」の基準値
        // 和音は低音から順にわずかにずらす（完全同時打鍵を避ける）
        const spread = accomp.length > 1 ? (i / (accomp.length - 1)) * p.chordSpreadMs * rng.range(0.3, 1) : 0;
        n.offMs = accompOff + spread * k + j(1.5);
      });
      // 右手: 拍ごとのタメ・走り・フレーズ末のタメは旋律と内声で共有し、旋律だけを先行させる（フレーズ末のタメは右手だけ）
      const rh = c.notes.filter((n) => n.hand === 'R');
      if (!rh.length) continue;
      const m = c.melody;
      const isEnd = !!(m && m.isPhraseEnd);
      const arc = MH.phraseArc(m ? m.phrasePos : MH.phrasePosAt(phrases, c.tick), p.arcPeak) - 0.5;
      const rhOff = shiftOff + (isEnd ? p.phraseEndRitMs : 0) * k;
      if (m) {
        m.arcVel = p.melodyVelArc * arc;
        m.arcMain = true; // 抑揚のレーンの自動の値は旋律の山なり
        let v = p.melodyVelBase + m.arcVel + accent + j(p.velJitter * velSd);
        if (isEnd) v -= p.phraseEndSoften;
        m.vel = v;
        m.velRef = p.melodyVelBase;
        m.offMs = rhOff - p.melodyLeadMs * k + j(p.melodyTimingSd);
      }
      // 内声: 旋律より弱く、抑揚は旋律の一部だけ追従。和音は下から順にわずかにずらす
      const inner = rh.filter((n) => n.role === 'inner');
      const innerOff = rhOff + j(p.melodyTimingSd * 0.5);
      inner.forEach((n, i) => {
        n.arcVel = p.melodyVelArc * p.rhInnerArcRatio * arc;
        let v = p.melodyVelBase - p.rhInnerVelOffset + n.arcVel + accent * 0.8 + j(p.velJitter * 0.7 * velSd);
        if (isEnd) v -= p.phraseEndSoften * p.rhInnerArcRatio;
        n.vel = v;
        n.velRef = p.melodyVelBase;
        const spread = inner.length > 1 ? (i / (inner.length - 1)) * p.chordSpreadMs * 0.5 * rng.range(0.3, 1) : 0;
        n.offMs = innerOff + spread * k + j(1.5);
      });
    }
    for (const n of notes) {
      n.origTick = n.tick;
      n.origEnd = n.endTick;
      n.tick = n.tick + ms(n.tick, n.offMs || 0) + (n.swingTicks || 0);
    }

    // --- 長さ（終了位置） ---
    const melody = notes.filter((n) => n.role === 'melody').sort((a, b) => a.origTick - b.origTick);
    melody.forEach((n, i) => {
      const next = melody[i + 1];
      const len = n.origEnd - n.origTick;
      if (next && next.origTick - n.origEnd <= ppq / 8) {
        // レガート: 次の音の頭に少し重ねる
        n.endTick = next.tick + ms(next.tick, p.legatoMs * rng.range(0.6, 1.3));
      } else {
        n.endTick = n.tick + len * (1 + j(p.lengthJitter)) * (n.isPhraseEnd ? 1 + p.phraseEndExtend : 1);
      }
    });
    for (const n of notes) {
      if (n.role === 'melody') continue;
      const ratio = n.role === 'accomp' ? p.accompLengthRatio : 1;
      n.endTick = n.tick + (n.origEnd - n.origTick) * ratio * (1 + j(p.lengthJitter));
    }

    // --- サステインペダル(CC64): 小節頭で踏み替え（小節頭の音を弾いた直後に上げ→踏む） ---
    // 小節線をまたいで指で押さえている音があれば、その小節線では踏み替えない（響きが続いているため）。
    // ただし前の小節と響きが混ざると濁るコードに変わる小節線（MH.chordCutBars）では、押さえている音があっても必ず踏み替える
    const ccs = [];
    if (p.pedal && clusters.length) {
      const clamp = (v) => Math.max(64, Math.min(127, Math.round(v)));
      // 小節頭とみなす幅（32分音符）。実演奏では小節頭の音がわずかに前後するため、その音を「小節線をまたいで押さえている音」と誤認しない
      const near = ppq / 8;
      const changes = pedalChangeTicks(maps, clusters[0].tick, clusters[clusters.length - 1].tick + near);
      const cutBars = p.pedalOnChordChange
        ? MH.chordCutBars(MH.detectBarChords(notes, maps, { startOf: (n) => n.origTick, endOf: (n) => n.keyEnd ?? n.origEnd }))
        : new Set();
      let ci = 0;
      let down = false;
      let maxEndOrig = -Infinity;
      let maxKeyEnd = -Infinity; // 指で押さえていた終了位置（ペダルを長さに反映した正規化の後でも、ペダルで伸びた分を除く）
      let maxEndH = 0;
      const change = (st) => {
        const up = st + ms(st, Math.max(0, p.pedalReleaseMs + j(5)));
        const press = Math.max(up + ms(st, 20), st + ms(st, p.pedalPressMs + j(10)));
        if (down) ccs.push({ tick: up, cc: 64, value: 0 });
        ccs.push({ tick: press, cc: 64, value: clamp(p.pedalDepth + j(4)) });
        down = true;
      };
      for (const c of clusters) {
        if (down && c.tick - maxEndOrig >= ppq * p.pedalRestBeats) {
          // 長い休符の前ではペダルを上げて余韻を切る（休符中の小節線では踏み替えない）
          ccs.push({ tick: maxEndH + ms(maxEndH, 30), cc: 64, value: 0 });
          down = false;
        }
        // この和音までにある小節線（この和音が小節頭ならそれも含む）
        for (; ci < changes.length && changes[ci] <= c.tick + near; ci++) {
          const at = changes[ci];
          if (!down || (maxKeyEnd > at + near && !cutBars.has(maps.position(at + near).bar))) continue;
          // 小節頭に音があればその音（加工後の位置）から、無ければ小節線から踏み替える
          change(Math.abs(c.tick - at) <= near ? MH.minOf(c.notes, (n) => n.tick) : at);
        }
        if (!down) change(MH.minOf(c.notes, (n) => n.tick));
        for (const n of c.notes) {
          maxEndOrig = Math.max(maxEndOrig, n.origEnd);
          maxKeyEnd = Math.max(maxKeyEnd, n.keyEnd ?? n.origEnd);
          maxEndH = Math.max(maxEndH, n.endTick);
        }
      }
      if (down) ccs.push({ tick: maxEndH + ms(maxEndH, 60), cc: 64, value: 0 });
    }

    return { notes, ccs, replaceCC: p.pedal ? [64] : [], phraseStarts: phrases.map((ph) => ph.srcStart) };
  }

  MH.humanizers = MH.humanizers || {};
  MH.humanizers.piano = humanizePiano;
})(typeof window !== 'undefined' ? window : globalThis);
