/**
 * ドラム用ヒューマナイザー。音の高さ→パーツの対応はドラムマップ（初期値はGM配列）で決める。
 *  - パーツ別のベロシティ基準（パーツの種類ごと。ハイハットは閉・ペダル・開で別々）と、拍位置によるアクセント（ハイハット裏拍を弱く等）
 *  - 強拍・弱拍: 強弱のパターン（accentGrid。2小節）のマスの値をすべてのパーツに足す。プラスのマスは強拍とみなす。強拍度（MH.accentGridLevelAt）でベロシティのランダム幅も変える（タイミングには効かない）
 *  - 拍の頭ではない16分スネアをゴーストノート化（強拍のスネアは除く）
 *  - パーツ別のタイミング傾向（キックは正確、スネアはわずかに後ろ、ハイハットは揺れ大）
 *  - 拍ごとのタメ・走り（beatShift。すべてのパーツ。8分・16分のスイングも含む）
 *  - タム回し（フィル）の中でクレッシェンド
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  function humanizeDrums(notes, ctx, p) {
    const { maps, rng, k, ppq } = ctx;
    const resolve = MH.drumPartResolver(ctx.drumMap);
    // 詳細パーツ（ハイタム・クラッシュ（右）等）はベロシティの基準値（ハイハットのみ）だけに使い、それ以外は種類（'hat'・'tom' 等）で扱う
    const partOf = (pitch) => MH.drumPartType(resolve(pitch));
    const ms = (tick, v) => maps.msToTicks(tick, v);
    const j = (sd) => rng.gauss(sd * k);

    // ベロシティの基準値（種類ごと。ハイハットは詳細パーツごと）
    const base = { kick: p.kickVel, snare: p.snareVel, rim: p.rimVel, hatClosed: p.hatVel, hatPedal: p.hatPedalVel, hatOpen: p.hatOpenVel, tom: p.tomVel, crash: p.cymbalVel, ride: p.rideVel, perc: p.percVel };
    const baseOf = (pitch) => base[resolve(pitch)] ?? base[partOf(pitch)];
    // パーツ別のずれ
    const timing = {
      kick: () => j(p.kickSd),
      snare: () => p.snareLaybackMs * k + j(p.snareSd),
      rim: () => p.snareLaybackMs * k + j(p.snareSd),
      hat: () => j(p.hatSd),
      ride: () => j(p.hatSd),
      tom: () => j(p.tomSd),
      crash: () => j(p.cymbalSd),
      perc: () => j(p.hatSd),
    };

    // タム回しの検出: 1拍以内の間隔で連続するタム
    const toms = notes.filter((n) => partOf(n.pitch) === 'tom').sort((a, b) => a.tick - b.tick);
    let run = [];
    const flushRun = () => {
      if (run.length >= 3) run.forEach((n, i) => (n.fillPos = i / (run.length - 1)));
      run = [];
    };
    for (const n of toms) {
      if (run.length && n.tick - run[run.length - 1].tick > ppq) flushRun();
      run.push(n);
    }
    flushRun();

    for (const n of notes) {
      const part = partOf(n.pitch);
      const pos = maps.position(n.tick);
      const lvl = pos.level;
      const basePart = baseOf(n.pitch);
      let v = basePart;
      const accent = MH.accentGridAt(p.accentGrid, pos, MH.ACCENT_SCALE.drums); // 強拍・弱拍
      const lv = MH.accentGridLevelAt(p.accentGrid, pos, MH.ACCENT_SCALE.drums); // 強拍度（-1〜+1）
      const strongHit = accent > 0; // 強拍の音には、拍の位置による弱め（裏拍・16分の減衰）をかけない

      if (part === 'hat' || part === 'ride' || part === 'perc') {
        const scale = part === 'ride' ? 0.6 : 1;
        if (lvl <= 1) v += p.hatAccent * scale;
        else if (!strongHit) v -= (lvl === 2 ? p.hatOffCut : p.hat16Cut) * scale;
      } else if ((part === 'snare' || part === 'rim') && !strongHit) {
        if ((lvl === 3 || lvl === 4) && p.ghostNotes) {
          v = p.ghostVel;
          n.ghost = true;
        } else if (lvl === 2) v -= 14;
        else if (pos.pulses >= 4 && pos.beat % 2 === 0) v -= 6; // 2・4拍目以外（裏打ちでない）のスネア
      } else if (part === 'kick') {
        if (lvl === 0) v += p.kickDownbeat;
        else if (lvl >= 2 && !strongHit) v -= 6;
      }
      if (!n.ghost) v += accent * p.accentVelDepth; // ゴーストノートは強さを変えない
      if (n.fillPos != null) v += p.fillCresc * (n.fillPos - 0.5);
      // 数小節単位のゆるやかな盛り上がり
      const groupPos = ((pos.bar % p.phraseBars) + pos.posInBar / pos.barTicks) / p.phraseBars;
      n.arcVel = p.phraseArc * (groupPos - 0.5); // 抑揚（自動）の分。抑揚のレーンを描いたときは pipeline で差し替える
      n.arcMain = true;
      v += n.arcVel;
      v += j((n.ghost ? p.velJitter * 0.6 : p.velJitter) * MH.accentSdScale(lv, p.accentVelSdDiff));
      n.vel = v;
      n.velRef = basePart; // ベロシティ基準「相対」の基準値

      // 拍ごとのタメ・走り（すべてのパーツ）
      const bs = MH.beatShiftOf(p.beatShift, pos.pulses);
      let off = timing[part]() + MH.beatShiftAt(bs, pos.posInBar / pos.pulseTicks) * k;
      if ((part === 'hat' || part === 'ride') && lvl >= 2) off += p.hatOffPushMs * k;
      if (n.ghost) off += j(p.ghostSd);
      n.origTick = n.tick;
      n.origEnd = n.endTick;
      const d = ms(n.tick, off) + Math.round(MH.swingShift(bs, pos.posInBar / ppq) * ppq * k);
      n.tick += d;
      n.endTick += d;
    }

    return { notes, ccs: [], replaceCC: [] };
  }

  MH.humanizers = MH.humanizers || {};
  MH.humanizers.drums = humanizeDrums;
})(typeof window !== 'undefined' ? window : globalThis);
