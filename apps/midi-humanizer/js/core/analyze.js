/**
 * 分析段: ヒューマナイズの前に行う判定（ピアノの左手／右手・ギターのストローク方向とミュート奏法・フレーズの区切り）。
 * 乱数は使わない。ヒューマナイザーは判定せず、ここの結果を使う。
 *
 *   一次データ ──[読み込み段 core/source.js]──▶ [分析段 ここ] ──▶ [実行段 humanizers/pipeline.js・normalizer.js]
 *
 * 結果はノートのキー（元のMIDI上の開始位置で引く。MH.noteKeyOf）の Map と、区切りの位置（元のMIDI上の位置）。
 * 呼び出し側は結果を覚えておき、次から known として渡す。known にある値は判定し直さず、無いノートだけ判定する
 * （判定は前後の音に依存するため、加工対象のノート全体を渡す）。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const keyOf = (n) => MH.handNoteKey(n, n.srcTick ?? n.tick);
  /** 同時発音とみなす開始位置の差 */
  const tolOf = (ppq) => Math.max(1, ppq / 48);

  /**
   * ピアノの手の中の役割を付ける: 右手の最高音=旋律（鳴り続けている旋律より下なら内声）、右手の他=内声、左手=伴奏。
   * 各ノートに role、旋律のあるクラスタに melody を付ける（ノートの hand は確定済みであること）
   * @returns {{tick:number, notes:object[]}[]} 旋律の音だけのクラスタ（フレーズ検出・フレーズ内の位置の付与に使う）
   */
  function pianoRoles(clusters, tol) {
    let lastMelody = null;
    for (const c of clusters) {
      c.notes.forEach((n) => (n.role = n.hand === 'R' ? 'inner' : 'accomp'));
      const rh = c.notes.filter((n) => n.hand === 'R');
      if (!rh.length) continue;
      const top = rh[rh.length - 1];
      // 指で押さえている旋律（ペダルで伸びているだけの音は除く）
      const sustaining = lastMelody && (lastMelody.keyEnd ?? lastMelody.endTick) > c.tick + tol ? lastMelody : null;
      if (!(sustaining && top.pitch < sustaining.pitch)) {
        top.role = 'melody';
        c.melody = top;
        lastMelody = top;
      }
    }
    return clusters.filter((c) => c.melody).map((c) => ({ tick: c.tick, notes: [c.melody] }));
  }

  /** フレーズ検出の設定（starts を渡すと検出せず、その位置で区切る。MH.detectPhrases を参照） */
  const phraseOpts = (p, ppq, starts) => ({ gapTicks: ppq * p.phraseGapBeats, maxBars: p.phraseBars, starts: starts || null });

  /** ピアノの手の割り当ての設定（MH.assignHands を参照） */
  const handOpts = (p, ppq, hands) => ({ mode: p.handMode, splitPitch: p.splitPitch, span: p.handSpan, tolTicks: tolOf(ppq), windowTicks: ppq, parts: hands.parts, overrides: hands.overrides, fixed: hands.fixed });

  function analyzePiano(notes, maps, ppq, p, known) {
    const hands = known.hands || {};
    MH.assignHands(notes, handOpts(p, ppq, hands));
    const out = { hands: new Map() };
    for (const n of notes) if (n.handEst) out.hands.set(keyOf(n), n.handEst);
    // フレーズは旋律で検出する（旋律がなければ全体で）。旋律はユーザーが修正した手で決める
    if (!known.phrases) {
      const clusters = MH.clusterOnsets(notes, tolOf(ppq));
      const melody = pianoRoles(clusters, tolOf(ppq));
      out.phrases = MH.detectPhrases(melody.length ? melody : clusters, maps, phraseOpts(p, ppq)).map((ph) => ph.srcStart);
    }
    return out;
  }

  /** ストロークの刻みが16分か（2音以上の和音が16分以下の位置にある）。既定の方向のパターン（と扱えない拍子の交互）の ↓↑ の単位に使う */
  function strumUse16(clusters, maps) {
    return clusters.some((c) => c.notes.length >= 2 && maps.position(c.tick).level >= 3);
  }

  /**
   * ギター: 方向（2音以上の和音）とミュート奏法（すべての同時発音）。
   * 方向: 判定済み（known.strums.fixed）> 判定（strumMode。'pattern' なら strumDirPattern、それ以外は推定 core/strums.js）。
   * 奏法: 判定済み（known.strums.articFixed）> 判定（articMode。'pattern' なら strumArticPattern、それ以外は推定: 強拍（強拍のパターン strumStrongPattern でプラスのマスの和音）は通常、
   *   それ以外は元のMIDIで短い和音をブラッシング > 推定（PM・ブラッシング）> 通常）
   */
  function analyzeGuitar(notes, maps, ppq, p, known) {
    const clusters = MH.clusterOnsets(notes, tolOf(ppq));
    const strums = known.strums || {};
    const valueIn = (map, c, valid) => {
      if (!map) return null;
      for (const n of c.notes) {
        const d = map.get(keyOf(n));
        if (valid.includes(d)) return d;
      }
      return null;
    };
    const fixedDirs = clusters.map((c) => (c.notes.length >= 2 ? valueIn(strums.fixed, c, ['D', 'U']) : null));
    const fixedArtics = clusters.map((c) => valueIn(strums.articFixed, c, MH.ARTICS));
    const dirPattern = p.strumMode === 'pattern';
    const articPattern = p.articMode === 'pattern';
    // 強拍: 強拍のパターン（strumStrongPattern。楽器固有の詳細設定）でプラスのマスの和音（パターンの扱えない拍子は小節頭・拍頭）。方向の推定でダウン寄り、奏法の推定で通常にする
    const strong = clusters.map((c) => {
      const pos = maps.position(c.tick);
      const pat = MH.strumPatternOf(p.strumStrongPattern, pos.meter);
      return pat ? pat.acc[MH.strumSlotAt(pos.meter, pos.posInBar, pos.barTicks)] > 0 : pos.level <= 1;
    });
    const unknown = clusters.some((c, ci) => (c.notes.length >= 2 && !fixedDirs[ci]) || !fixedArtics[ci]);
    const est = unknown && (!dirPattern || !articPattern) ? MH.estimateStrums(clusters, maps, p, strong) : null;
    const use16 = strumUse16(clusters, maps);
    const brushTicks = p.brushDetectBeats * ppq;

    const out = { strums: new Map(), artics: new Map() };
    clusters.forEach((c, ci) => {
      const pos = maps.position(c.tick);
      const slot = MH.strumSlotAt(pos.meter, pos.posInBar, pos.barTicks);
      const chord = c.notes.length >= 2;
      const fixed = fixedDirs[ci];
      const gridTicks = pos.compound ? pos.pulseTicks / 3 : pos.pulseTicks / (use16 ? 4 : 2);
      const dirs = !fixed && dirPattern ? MH.strumDirOf(p.strumDirPattern, pos.meter, use16) : null;
      const smart = chord && !fixed && !dirPattern ? est[ci].dir : null;
      // パターンの扱えない拍子（1小節が64マス超）では表拍=ダウン・裏拍=アップ
      const autoDown = fixed ? fixed === 'D' : smart ? smart === 'D' : dirs ? dirs[slot] === 'D' : Math.round(pos.posInBar / gridTicks) % 2 === 0;
      let artic = fixedArtics[ci];
      if (!artic) {
        if (articPattern) {
          const pa = MH.strumArticOf(p.strumArticPattern, pos.meter);
          artic = pa ? pa[slot] : 'N';
        } else if (strong[ci]) {
          artic = 'N'; // 強拍ではミュート・ブラッシングにしない
        } else {
          // 短い音の判定は和音だけ（単音は速いリード・スタッカートと区別できない。単音の推定は低音の刻みが続く場合だけ）
          artic =
            brushTicks > 0 && chord && c.notes.every((n) => (n.keyEnd ?? n.endTick) - n.tick <= brushTicks)
              ? 'X'
              : est[ci].artic
                ? est[ci].artic
                : est[ci].brush && chord && !autoDown // ブラッシングは判定した方向がアップの和音だけ（ユーザーの修正では変えない）
                  ? 'X'
                  : 'N';
        }
      }
      for (const n of c.notes) {
        if (chord) out.strums.set(keyOf(n), autoDown ? 'D' : 'U');
        out.artics.set(keyOf(n), artic);
      }
    });
    if (!known.phrases) out.phrases = MH.detectPhrases(clusters, maps, phraseOpts(p, ppq)).map((ph) => ph.srcStart);
    return out;
  }

  /**
   * 準備済みのノート（MH.prepareNotes の結果。srcTick・keyEnd 付き）を分析する。notes は書き換えない
   * @param {{hands?:{parts?:object, overrides?:Map, fixed?:Map}, strums?:{fixed?:Map, articFixed?:Map}, phrases?:number[]|null}} [known]
   *   hands.parts: 'トラック:チャンネル' → 手（左手・右手が別パート）、hands.overrides: ユーザーが修正した手（旋律の判定に使う）、
   *   hands.fixed / strums.fixed / strums.articFixed: 判定済みの値、phrases: 区切り（あれば検出しない）
   * @returns {{hands?:Map<string,'R'|'L'>, strums?:Map<string,'D'|'U'>, artics?:Map<string,'N'|'X'|'P'>, phrases?:number[]}}
   *   hands・strums・artics は判定済みの値を含む全体（hands はパート指定のノートを除く。strums は2音以上の和音のノートだけ）。phrases は検出したときだけ
   */
  function analyzeNotes(notes, maps, ppq, instrument, params, known) {
    const p = Object.assign(MH.defaultParams(instrument), params || {});
    const work = notes.map((n) => Object.assign({}, n));
    if (instrument === 'piano') return analyzePiano(work, maps, ppq, p, known || {});
    if (instrument === 'guitar') return analyzeGuitar(work, maps, ppq, p, known || {});
    return {};
  }

  /** 加工対象のパートの MIDI を分析する（analyzeNotes を参照） */
  function analyzePart(midi, instrument, params, known) {
    const notes = MH.prepareNotes(midi);
    return analyzeNotes(notes, MH.buildTimeMaps(midi), midi.ppq, instrument, params, known);
  }

  Object.assign(MH, { analyzeNotes, analyzePart, pianoRoles, strumUse16, handOptsOf: handOpts, phraseOptsOf: phraseOpts });
})(typeof window !== 'undefined' ? window : globalThis);
