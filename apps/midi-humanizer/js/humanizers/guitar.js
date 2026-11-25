/**
 * ギター用ヒューマナイザー。
 *  - 3音以上の同時発音 = ストローク: 弦ごとに発音をずらし、ダウン/アップで強弱と順序を変える
 *  - 1小節の強弱のパターン（strumPattern。16分のマスごと）。強拍度（MH.strumAccentLevelAt）でベロシティのランダム幅も変える（タイミング・長さには効かない）
 *  - ストローク方向: ユーザーの修正（ctx.strums.overrides）> 分析した方向（ctx.analysis.strums。判定は分析段 core/analyze.js）。
 *    和音の各ノートに strumDir（確定値）・strumAuto（修正が無い場合の値）・strumId（和音の識別子）を付ける
 *  - ミュート奏法（'N'=通常 / 'X'=ブラッシング / 'P'=パームミュート）: ユーザーの修正（ctx.strums.articOverrides）> 分析した奏法（ctx.analysis.artics。判定は分析段 core/analyze.js）。単音にも付ける。
 *    各ノートに artic（確定値）・articAuto（修正が無い場合の値）・articId（同時発音の識別子）を付ける。乱数の消費順は奏法によらない
 *  - 拍ごとのタメ・走り（beatShift。すべての音。8分・16分のスイングも含む）
 *  - 単音 = アルペジオ/リード: 次の小節頭まで余韻を伸ばす（let ring）
 *  - 長音のビブラート: CC1（モジュレーション）で音源に任せるか、ピッチベンドで波形を直接書く（音源によって使える方を選ぶ）
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  function humanizeGuitar(notes, ctx, p) {
    const { maps, rng, k, ppq } = ctx;
    const ms = (tick, v) => maps.msToTicks(tick, v);
    const j = (sd) => rng.gauss(sd * k);
    const tol = Math.max(1, ppq / 48);
    const clusters = MH.clusterOnsets(notes, tol);
    const phrases = MH.detectPhrases(clusters, maps, MH.phraseOptsOf(p, ppq, ctx.phrases));

    // ユーザーが修正した値・分析した値（ノートのキー → 方向 'D'|'U' / 奏法）。キーは元のMIDI上の開始位置（srcTick）で引くため、正規化の設定を変えても外れない
    const strums = ctx.strums || {};
    const valueIn = (map, c, valid) => {
      if (!map) return null;
      for (const n of c.notes) {
        const d = map.get(MH.handNoteKey(n, n.srcTick ?? n.tick));
        if (valid.includes(d)) return d;
      }
      return null;
    };
    const dirIn = (map, c) => valueIn(map, c, ['D', 'U']);
    const articIn = (map, c) => valueIn(map, c, MH.ARTICS);

    clusters.forEach((c) => {
      const pos = maps.position(c.tick);
      // 1小節のパターン（16分のマス）の強弱
      const pat = MH.strumPatternOf(p.strumPattern, pos.meter);
      const slot = MH.strumSlotAt(pos.meter, pos.posInBar, pos.barTicks);
      const chord = c.notes.length >= 2;
      const lv = MH.strumAccentLevelAt(p.strumPattern, pos); // 強拍度（-1〜+1）
      // 拍ごとのタメ・走り（すべての音。和音は掻き始めごとずらす）とスイング
      const bs = MH.beatShiftOf(p.beatShift, pos.pulses);
      const shiftOff = MH.beatShiftAt(bs, pos.posInBar / pos.pulseTicks) * k;
      const swingTicks = Math.round(MH.swingShift(bs, pos.posInBar / ppq) * ppq * k);
      for (const note of c.notes) note.swingTicks = swingTicks;
      // 方向・奏法: ユーザーの修正 > 分析した値（判定は分析段 core/analyze.js で済ませている）
      const autoDown = chord ? (dirIn(ctx.analysis.strums, c) || 'D') === 'D' : true;
      const user = chord ? dirIn(strums.overrides, c) : null;
      const down = user ? user === 'D' : autoDown;
      const articAuto = articIn(ctx.analysis.artics, c) || 'N';
      const artic = articIn(strums.articOverrides, c) || articAuto;
      // 同時発音の識別子（方向・奏法を同時発音ごとにまとめて修正するのに使う）
      const groupId = c.notes[0].track + ':' + c.notes[0].ch + ':' + Math.round(c.tick);
      for (const note of c.notes) Object.assign(note, { artic, articAuto, articId: groupId });
      c.artic = artic;
      // 抑揚（自動）の分。抑揚のレーンを描いたときは pipeline で差し替える（レーンの自動の値は同時発音の先頭の音から取る）
      const arcVel = p.phraseArc * (MH.phraseArc(c.phrasePos, p.arcPeak) - 0.5);
      c.notes.forEach((note, i) => Object.assign(note, { arcVel, arcMain: i === 0 }));
      let baseV = p.velBase + arcVel + (pat ? pat.acc[slot] : MH.legacyAccent(pos.level)) * p.accentVelDepth + j(p.velJitter * MH.accentSdScale(lv, p.accentVelSdDiff));
      if (artic === 'X') baseV -= p.brushVelCut;
      else if (artic === 'P') baseV -= p.pmVelCut;

      if (c.notes.length >= 2) {
        c.isStrum = c.notes.length >= p.strumMinNotes;
        const order = down ? c.notes.slice() : c.notes.slice().reverse();
        const n = order.length;
        if (c.isStrum) baseV += down ? p.downVelBoost : -p.upVelCut;
        const spreadMs = (down ? p.strumDownMs : p.strumUpMs) * ((n - 1) / 5) * (1 + j(p.strumSpreadJitter)) * (artic === 'X' ? p.brushSpreadRatio : 1);
        const chordOff = shiftOff + j(p.timingSd);
        // 方向は和音単位。strumId で同じ和音のノートをまとめて修正できるようにする
        for (const note of c.notes) Object.assign(note, { strumDir: down ? 'D' : 'U', strumAuto: autoDown ? 'D' : 'U', strumId: groupId });
        order.forEach((note, i) => {
          const t = n > 1 ? i / (n - 1) : 0;
          // 拍の位置を中心より少し前から掻き始める
          note.offMs = chordOff + (t - 0.3) * spreadMs + j(1);
          let v = baseV - i * p.stringVelDecay + j(2);
          if (c.isStrum && !down && i >= n - 2) v -= 4; // アップでは低音弦が弱く当たる
          // パームミュートは手のひらで押さえるので、高い音ほど弱い（order は掻いた順なので、音の高さの順は c.notes で見る）
          if (artic === 'P' && n > 1) v -= p.pmHighCut * (c.notes.indexOf(note) / (n - 1));
          note.vel = v;
          note.velRef = p.velBase; // ベロシティ基準「相対」の基準値
          note.strum = true; // 掻き時間によるずれは強さ0でも残る
        });
      } else {
        const note = c.notes[0];
        note.offMs = shiftOff + j(p.timingSd * 1.2);
        note.vel = baseV;
        note.velRef = p.velBase;
      }
    });
    for (const n of notes) {
      n.origTick = n.tick;
      n.origEnd = n.endTick;
      n.tick = n.tick + ms(n.tick, n.offMs || 0) + (n.swingTicks || 0);
    }

    // --- 長さ ---
    // 各クラスタより後ろで最初に来るストロークを後ろから求めておく
    const nextStrums = new Array(clusters.length);
    for (let i = clusters.length - 1, found = null; i >= 0; i--) {
      nextStrums[i] = found;
      if (clusters[i].isStrum) found = clusters[i];
    }
    clusters.forEach((c, ci) => {
      const next = clusters[ci + 1];
      const nextStartH = next ? MH.minOf(next.notes, (n) => n.tick) : Infinity;
      const nextStrum = nextStrums[ci];
      for (const note of c.notes) {
        const len = note.origEnd - note.origTick;
        if (c.notes.length >= 2) {
          let end = note.tick + len;
          if (next && next.tick - note.origEnd <= ppq / 8) {
            // 次の音の直前で手が離れる/ミュートされる
            end = Math.min(end, nextStartH - ms(nextStartH, p.muteGapMs * rng.range(0.6, 1.4)));
          }
          note.endTick = end + ms(note.tick, j(3));
        } else {
          const pos = maps.position(note.origTick);
          let target = Math.min(pos.barStartTick + pos.barTicks, note.origTick + p.ringMaxBeats * pos.pulseTicks);
          if (nextStrum) target = Math.min(target, nextStrum.tick);
          const baseEnd = note.origTick + len;
          const ring = p.letRing * Math.max(0, target - baseEnd);
          note.endTick = baseEnd + ring + (note.tick - note.origTick) + len * j(p.lengthJitter);
        }
        // ミュート奏法は短く切る（余韻・次の音までの長さより短いときだけ。乱数は使わない）
        if (c.artic === 'X') note.endTick = Math.min(note.endTick, note.tick + ms(note.tick, p.brushMs));
        else if (c.artic === 'P') note.endTick = Math.min(note.endTick, note.tick + Math.min(len * p.pmLenRatio, ms(note.tick, p.pmMaxMs)));
      }
    });

    // --- コードの変わり目のミュート: 前の小節と響きが混ざると濁るコードに変わる小節線（MH.chordCutBars）をまたぐ音は、その手前で止める ---
    if (p.muteOnChordChange) {
      const near = ppq / 8; // 小節頭とみなす幅（32分音符）
      const minLen = ppq / 16; // これより短くなる音は縮めない（小節線の直後に短い音が残らないように）
      const cutBars = MH.chordCutBars(MH.detectBarChords(notes, maps, { startOf: (n) => n.origTick, endOf: (n) => n.origEnd }));
      for (const c of clusters) {
        const pos = maps.position(c.tick + near);
        if (!cutBars.has(pos.bar)) continue;
        // 小節頭に音があればその音（加工後の位置）の手前、無ければ小節線の手前で止める
        const at = Math.abs(c.tick - pos.barStartTick) <= near ? MH.minOf(c.notes, (n) => n.tick) : pos.barStartTick;
        const stop = at - ms(at, p.muteGapMs * rng.range(0.6, 1.4));
        for (const n of notes) {
          if (n.origTick < pos.barStartTick - near && n.endTick > stop && stop > n.tick + minLen) n.endTick = stop;
        }
        cutBars.delete(pos.bar);
      }
    }

    const ccs = [];
    const replaceCC = [];
    // --- ビブラート: 長い単音に遅れてかける（CC1 で音源に任せる／ピッチベンドで波形を直接書く） ---
    const vibTargets = clusters.filter((c) => c.notes.length === 1 && c.notes[0].origEnd - c.notes[0].origTick >= ppq * p.modMinBeats).map((c) => c.notes[0]);
    let pbs = [];
    if (p.vibrato === 'cc1') {
      replaceCC.push(1);
      for (const n of vibTargets) {
        const len = n.endTick - n.tick;
        const startT = n.tick + len * 0.4;
        const steps = 6;
        for (let s = 1; s <= steps; s++) {
          ccs.push({ tick: startT + (len * 0.3 * s) / steps, cc: 1, value: Math.round((p.modDepth * s) / steps) });
        }
        ccs.push({ tick: n.endTick, cc: 1, value: 0 });
      }
    } else if (p.vibrato === 'pb') {
      replaceCC.push('pb');
      pbs = pitchVibrato(vibTargets, notes, ctx, p);
    }

    return { notes, ccs, replaceCC, pbs, phraseStarts: phrases.map((ph) => ph.srcStart) };
  }

  /** 波形（1周ぶんの点列。値は -1〜1）を位相（周回数）で線形補間する */
  function waveAt(wave, phase) {
    const n = wave.length;
    const x = (phase - Math.floor(phase)) * n;
    const i = Math.floor(x);
    return wave[i % n] + (wave[(i + 1) % n] - wave[i % n]) * (x - i);
  }

  /**
   * なめらかな揺らぎ（-1〜1）。周回数1つごとに乱数の節を置き、間を cos で補間する
   * 節は必要になった分だけ作る（呼び出し順が決まっているのでシードで再現できる）
   */
  function smoothNoise(rng) {
    const knots = [];
    return (pos) => {
      const i = Math.floor(pos);
      while (knots.length <= i + 1) knots.push(rng.range(-1, 1));
      const f = (1 - Math.cos((pos - i) * Math.PI)) / 2;
      return knots[i] + (knots[i + 1] - knots[i]) * f;
    };
  }

  /**
   * ピッチベンドのビブラート。振幅は AM（なめらかな揺らぎを掛ける）、速さは FM（位相の進み方を揺らす）で、時間とともに揺らぐ。
   * ピッチベンドはチャンネル全体に効くため、次の音が鳴る位置で 0 に戻す（余韻で鳴っている他の音まで揺らさない）
   * @returns {{tick:number, value:number}[]} 値は -8192〜8191
   */
  function pitchVibrato(targets, notes, ctx, p) {
    const { maps, rng, ppq } = ctx;
    const onsets = [...new Set(notes.map((n) => Math.round(n.tick)))].sort((a, b) => a - b);
    const step = Math.max(1, Math.round(ppq / 32));
    const loopTicks = Math.max(1, p.vibLoopBeats * ppq);
    const toPb = 8191 / (p.pbRange * 100); // 1セントあたりのPB値
    const out = [];
    for (const n of targets) {
      // 次の発音位置（二分探索）
      let lo = 0;
      let hi = onsets.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (onsets[mid] > n.tick + 1) hi = mid;
        else lo = mid + 1;
      }
      const end = Math.min(n.endTick, lo < onsets.length ? onsets[lo] : Infinity);
      const endMs = maps.tickToMs(end);
      const startMs = maps.tickToMs(n.tick) + p.vibDelayMs;
      if (startMs >= endMs) continue;
      const am = smoothNoise(rng);
      const fm = smoothNoise(rng);
      let last = null;
      const push = (tick, value) => {
        const v = Math.round(value);
        if (v !== last) out.push({ tick, value: v });
        last = v;
      };
      let phase = 0; // 波形の位相（FM で揺れる）
      let base = 0; // 揺らぎの位置（揺らさない速さで進む。揺らぎの変化はビブラート1周に1回程度）
      for (let t = maps.msToTick(startMs); t < end; t += step) {
        const ms = maps.tickToMs(t);
        const fadeIn = p.vibFadeInMs > 0 ? (ms - startMs) / p.vibFadeInMs : 1;
        const fadeOut = p.vibFadeOutMs > 0 ? (endMs - ms) / p.vibFadeOutMs : 1;
        const env = Math.max(0, Math.min(1, fadeIn, fadeOut));
        const depth = Math.max(0, p.vibDepth * (1 + p.vibDepthRand * am(base)));
        push(t, depth * toPb * env * waveAt(p.vibWave, phase));
        const adv = (step / loopTicks) * p.vibSpeed;
        phase += adv * Math.max(0.05, 1 + p.vibSpeedRand * fm(base));
        base += adv;
      }
      last = null;
      push(end, 0);
    }
    return out;
  }

  /**
   * ミュート奏法を書き出すMIDIに書き込む（楽器固有の詳細設定「ミュート奏法の出力」）。
   * 加工後のノートの artic を同時発音（articId）ごとに見て、奏法が変わる同時発音の直前（32分音符の1/4前）に書く。
   *  キースイッチ: 奏法ごとの音高のノート（最初の同時発音の前にも書く）。プログラムチェンジ: 通常⇔ミュート（ブラッシング・パームミュート）が変わるときだけ（曲頭は通常の音色とみなす）
   * @param {object} midi 書き出すMIDI（変更しない）
   * @param {object[]} notes 加工後のノート（artic・articId 付き。無いノートは無視）
   * @param {{articOutput:string, ksNormal:number, ksBrush:number, ksPalm:number, pcNormal:number, pcMute:number}} cfg pcNormal・pcMute は 1〜128
   * @returns {object} 書き込んだMIDI（出力しない設定なら midi そのもの）
   */
  function writeArticulations(midi, notes, cfg) {
    const mode = cfg && cfg.articOutput;
    if (mode !== 'keyswitch' && mode !== 'program') return midi;
    const lead = Math.max(1, Math.round(midi.ppq / 32)); // 同時発音のどれだけ前に書くか（32分音符の1/4）
    const KS_VEL = 100;
    const groups = new Map(); // articId → { tick, track, ch, artic }
    for (const n of notes) {
      if (!n.artic || !n.articId) continue;
      const g = groups.get(n.articId);
      if (g) g.tick = Math.min(g.tick, n.tick);
      else groups.set(n.articId, { tick: n.tick, track: n.track, ch: n.ch, artic: n.artic });
    }
    const byPart = new Map(); // 'トラック:チャンネル' → 同時発音（開始位置の順）
    for (const g of [...groups.values()].sort((a, b) => a.tick - b.tick)) {
      const key = g.track + ':' + g.ch;
      if (!byPart.has(key)) byPart.set(key, []);
      byPart.get(key).push(g);
    }
    const tracks = midi.tracks.map((t) => ({ endTick: t.endTick, events: t.events.slice() }));
    const KS = { N: cfg.ksNormal, X: cfg.ksBrush, P: cfg.ksPalm };
    for (const list of byPart.values()) {
      let prev = mode === 'program' ? 'N' : null;
      for (const g of list) {
        const cur = mode === 'program' ? (g.artic === 'N' ? 'N' : 'M') : g.artic;
        if (cur === prev) continue;
        prev = cur;
        const t = tracks[g.track];
        const at = Math.max(0, Math.round(g.tick) - lead);
        if (mode === 'keyswitch') {
          const end = Math.max(at + 1, Math.round(g.tick));
          // 曲頭の同時発音では書く位置が同じ tick になるので、同じ tick のノートより先に並ぶよう先頭に入れる（書き出しは同じ tick・種類なら配列の順）
          t.events.unshift({ tick: at, kind: 'ch', status: MH.STATUS.NOTE_ON, ch: g.ch, d1: KS[g.artic], d2: KS_VEL });
          t.events.push({ tick: end, kind: 'ch', status: MH.STATUS.NOTE_OFF, ch: g.ch, d1: KS[g.artic], d2: 64 });
          t.endTick = Math.max(t.endTick, end);
        } else {
          t.events.push({ tick: at, kind: 'ch', status: 0xc0, ch: g.ch, d1: (cur === 'N' ? cfg.pcNormal : cfg.pcMute) - 1 });
        }
      }
    }
    return { format: midi.format, ppq: midi.ppq, tracks };
  }

  MH.humanizers = MH.humanizers || {};
  MH.humanizers.guitar = humanizeGuitar;
  MH.writeArticulations = writeArticulations;
})(typeof window !== 'undefined' ? window : globalThis);
