/**
 * 正規化（ヒューマナイズの逆）: 開始位置をグリッドに寄せ、長さ・ベロシティを揃え、CCを整理する。
 * 演奏のテンポの揺れ（ノートの位置に入っているもの）は追いかけて取り除き、ファイルのテンポどおりの位置に揃える（js/core/quantize.js）。
 * スイングを取る指定があれば、ハネた裏の位置をまっすぐな位置へ戻してからクオンタイズする。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const EXPRESSION_CCS = [1, 11, 4];
  const CHORD_INSTRUMENTS = ['piano', 'guitar']; // コードの変わり目で音を終える楽器

  const partKey = (n) => n.track + ':' + n.ch;

  /** ペダル（CC64）で伸びていた分をノートの長さに書き込む */
  function bakePedal(midi, notes) {
    const pedals = new Map(); // ch → [{tick, down}]
    for (const t of midi.tracks) {
      for (const e of t.events) {
        if (e.kind !== 'ch' || e.status !== MH.STATUS.CC || e.d1 !== 64) continue;
        if (!pedals.has(e.ch)) pedals.set(e.ch, []);
        pedals.get(e.ch).push({ tick: e.tick, down: e.d2 >= 64 });
      }
    }
    for (const list of pedals.values()) {
      // 同tickでは up を先に（踏み替えで up→down を同時に書いた場合）
      list.sort((a, b) => a.tick - b.tick || a.down - b.down);
      // 各イベント以降で最初にペダルが上がる tick を後ろから求めておく
      for (let i = list.length - 1, up = null; i >= 0; i--) {
        list[i].nextUp = up;
        if (!list[i].down) up = list[i].tick;
      }
    }
    for (const n of notes) {
      const list = pedals.get(n.ch);
      if (!list) continue;
      // note-off 直前のペダル状態。出力時の並びは note-off → CC なので、同tickのペダル操作は含めない
      let lo = -1;
      let hi = list.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (list[mid].tick < n.endTick) lo = mid;
        else hi = mid - 1;
      }
      // 最後までペダルが上がらない場合は伸ばさない（曲末まで伸びて他の音を潰すのを避ける）
      if (lo >= 0 && list[lo].down && list[lo].nextUp != null) n.endTick = list[lo].nextUp;
    }
  }

  /** パートごとの開始位置一覧から、tick より後の最初の開始位置を返す */
  function makeNextOnset(notes, skip) {
    const byPart = new Map();
    for (const n of notes) {
      const k = partKey(n);
      if (!byPart.has(k)) byPart.set(k, new Set());
      byPart.get(k).add(Math.round(n.tick));
    }
    const sorted = new Map([...byPart].map(([k, set]) => [k, [...set].sort((a, b) => a - b)]));
    return (n) => {
      const list = sorted.get(partKey(n));
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid] <= Math.round(n.tick) + skip) lo = mid + 1;
        else hi = mid;
      }
      return lo < list.length ? list[lo] : null;
    };
  }

  /**
   * @param {{params:object, instrument?:string, layers?:{params:object|null, range?:{start:number, end:number}}[], cache?:Map}} opts
   *   layers（省略可）: 範囲ごとに重ねる正規化。ノート・CC・ピッチベンドは、その元のMIDI上の位置を範囲に含む最後のレイヤーの結果を使う。
   *   先頭のレイヤーは範囲によらず全体。params が null のレイヤーは元のまま。省略時は opts.params の1レイヤー。
   *   正規化はレイヤーごとに曲全体で行う（テンポの追跡などが範囲の端で途切れないように）。cache: 同じ設定の正規化を使い回す（呼び出し側で共有する Map）
   */
  function normalize(midi, opts) {
    const layers = opts && opts.layers && opts.layers.length ? opts.layers : [{ params: (opts && opts.params) || {} }];
    if (layers.length === 1 && layers[0].params) return normalizeAll(midi, Object.assign({}, opts, { params: layers[0].params }));
    const cache = (opts && opts.cache) || new Map();
    const results = layers.map((l) => {
      if (!l.params) return asIs(midi);
      const key = JSON.stringify(l.params);
      if (!cache.has(key)) cache.set(key, normalizeAll(midi, Object.assign({}, opts, { params: l.params })));
      return cache.get(key);
    });
    const out = MH.mergeResults(midi, layers, results, results.map((r) => r.before), (n) => n.origTick);
    // 設定・グリッドの表示は最後に実行した範囲のもの
    const last = results.filter((r) => r.grid).pop();
    return Object.assign(out, { before: results[0].before, params: last.params, grid: last.grid, removedCC: last.removedCC });
  }

  /** 正規化しない（範囲ごとの正規化で、まだ正規化していない部分）。normalizeAll と同じ形で返す */
  function asIs(midi) {
    const before = MH.extractNotes(midi);
    if (!before.length) throw new Error('ノートが含まれていません');
    const after = before.map((n) => Object.assign({}, n, { origTick: n.tick, origEnd: n.endTick, keyLen: n.endTick - n.tick }));
    return { midi, before, after };
  }

  function normalizeAll(midi, opts) {
    const p = Object.assign(MH.defaultsOf(MH.NORMALIZE_SCHEMA), (opts && opts.params) || {});
    const maps = MH.buildTimeMaps(midi);
    const before = MH.extractNotes(midi);
    if (!before.length) throw new Error('ノートが含まれていません');
    let notes = before.map((n) => Object.assign({}, n));

    // 指で押さえていた長さ（ペダルを反映する前）。ピアノの旋律・手の判定で使う
    for (const n of notes) n.keyLen = n.endTick - n.tick;
    if (p.pedalMode === 'bake') bakePedal(midi, notes);

    // スイングを取る: ハネた裏の位置をまっすぐな位置へ戻してからクオンタイズする（小節頭から音価で数える。ヒューマナイズのスイングの逆）
    const swing = p.swingGrid === '8' || p.swingGrid === '16' ? { swing: p.swingRatio, swingGrid: Number(p.swingGrid) } : null;
    const unswing = (t) => (swing ? t + MH.swingUnshift(swing, maps.position(Math.max(0, t)).posInBar / midi.ppq) * midi.ppq : t);
    const qNotes = swing ? notes.map((n) => Object.assign({}, n, { tick: unswing(n.tick), endTick: unswing(n.endTick) })) : notes;

    // 最小音価: 自動なら32分まで判定し、1割以上の拍で使われた最も細かい段に絞って判定し直す（まれな細かい解釈は誤りとみなす）
    const auto = p.minGrid === 'auto';
    const quantizeWith = (minGrid) => MH.quantize(qNotes, maps, { types: MH.quantizeTypes(minGrid, p.triplet), follow: p.tempoFollow });
    let minGrid = auto ? '32' : p.minGrid;
    let qz = quantizeWith(minGrid);
    if (auto && MH.minGridOf(qz.main) !== minGrid) qz = quantizeWith((minGrid = MH.minGridOf(qz.main)));
    // 固定長・legato の単位は最小音価（曲の内容で単位が変わらないように）
    const g = MH.gridTicksOf(midi.ppq, minGrid);
    const s = p.startStrength;

    // --- 開始位置 ---
    notes.forEach((n, i) => {
      n.origTick = n.tick;
      n.origEnd = n.endTick;
      n.snapTick = qz.q[i];
      n.snapType = qz.qType[i];
      n.tick += (n.snapTick - n.tick) * s;
    });

    // 同じパート・音高が同じ位置に寄った（速い連打がグリッドより細かかった）ら1音にまとめる
    const merged = new Map();
    notes = notes.filter((n) => {
      const k = partKey(n) + ':' + n.pitch + ':' + Math.round(n.tick);
      const first = merged.get(k);
      if (!first) {
        merged.set(k, n);
        return true;
      }
      first.origEnd = Math.max(first.origEnd, n.origEnd);
      first.vel = Math.max(first.vel, n.vel);
      first.keyLen = Math.max(first.keyLen, n.keyLen);
      return false;
    });
    const mergedCount = before.length - notes.length;

    // --- 終了位置・長さ ---
    // 完全に寄せる場合は厳密に「次の発音」。部分的に寄せる場合は和音のずれを同時発音とみなすため半グリッドを飛ばす
    const nextOnset = makeNextOnset(notes, s >= 1 ? 0 : g / 2);
    // 「元の長さに近い長さ」の単位: 最小音価（3連の位置で始まる音は、最小音価の段の3連）
    const tripletUnit = p.triplet ? MH.gridTicksOf(midi.ppq, minGrid === '8' ? '8t' : '16t') : g;
    const lenUnitOf = (n) => (/t$/.test(n.snapType) ? tripletUnit : g);
    // 楽譜上の長さ（テンポの揺れとスイングを除いた長さ）
    const scoreLen = (n) => qz.warp(unswing(n.origEnd)) - qz.warp(unswing(n.origTick));
    for (const n of notes) {
      const gridEnd = () => {
        const e = qz.snapEnd(unswing(n.origEnd));
        const qe = e.q > n.snapTick ? e.q : n.snapTick + e.g;
        return Math.max(n.tick + 1, n.origEnd + (qe - n.origEnd) * s);
      };
      if (p.endMode === 'nearest') {
        // 楽譜上の長さ（テンポの揺れを除いた長さ）に最も近い「単位の倍数（1倍以上）」を、揃える強さに応じて採用する
        const len = n.origEnd - n.origTick;
        const unit = lenUnitOf(n);
        const target = unit * Math.max(1, Math.round(scoreLen(n) / unit));
        n.endTick = n.tick + Math.max(1, len + (target - len) * s);
      } else if (p.endMode === 'grid') n.endTick = gridEnd();
      else if (p.endMode === 'fixed') n.endTick = n.tick + g * p.fixedGrids;
      else if (p.endMode === 'legato') {
        // 同じパートの次の発音まで伸ばす（1小節以上先なら通常のグリッド寄せ）
        const next = nextOnset(n);
        n.endTick = next != null && next - n.tick <= maps.position(n.tick).barTicks ? next : gridEnd();
      } else {
        // 元の長さ: 揃える強さに応じて、楽譜上の長さ（テンポの揺れを除いた長さ）に寄せる
        const len = n.origEnd - n.origTick;
        n.endTick = n.tick + Math.max(1, len + (scoreLen(n) - len) * s);
      }
    }

    // --- コードの変わり目: 前の小節と響きが混ざると濁るコードに変わる小節線（MH.chordCutBars）をまたぐ音は、その小節線で終える ---
    let chordCutCount = 0;
    if (p.cutOnChordChange && CHORD_INSTRUMENTS.includes(opts && opts.instrument)) {
      const near = midi.ppq / 8; // 小節頭とみなす幅（32分音符）。小節頭をわずかに早く弾いた音は切らない
      // 判定は指で押さえていた長さで（ペダルで伸びた分は前の小節の響きなので数えない）
      const bars = MH.detectBarChords(notes, maps, { endOf: (n) => n.tick + Math.max(1, Math.min(n.keyLen, n.endTick - n.tick)) });
      const cutBars = MH.chordCutBars(bars);
      for (const b of bars) {
        if (!cutBars.has(b.bar)) continue;
        for (const n of notes) {
          if (n.tick < b.startTick - near && n.endTick > b.startTick) {
            n.endTick = b.startTick;
            chordCutCount++;
          }
        }
      }
    }

    // --- ベロシティ ---
    if (p.velMode !== 'keep') {
      const target = p.velMode === 'mean' ? before.reduce((a, n) => a + n.vel, 0) / before.length : p.velValue;
      for (const n of notes) n.vel += (target - n.vel) * p.velStrength;
    }

    // --- CC ---
    const replaceCC = new Set();
    if (p.pedalMode !== 'keep') replaceCC.add(64);
    if (p.removeExpression) EXPRESSION_CCS.forEach((c) => replaceCC.add(c));
    const channels = new Set(notes.map((n) => n.ch));

    const out = MH.finalize(midi, maps, before, notes, [], replaceCC, channels);
    out.params = p;
    out.grid = { key: qz.main, label: MH.GRID_LABEL[qz.main], auto, minGrid, triplet: !!p.triplet, usage: qz.usage, tempo: qz.tempo, ambiguous: qz.ambiguous, offGrid: qz.offGrid, clusters: qz.clusters };
    out.removedCC = [...replaceCC];
    out.mergedCount = mergedCount;
    out.chordCutCount = chordCutCount;
    return out;
  }

  /**
   * 処理の入口。
   * mode: 'humanize' | 'normalize'（ノーマライズはMIDI編集モードで一次データに対して行う。core/source-edit.js の normalizeSource）
   * part: 処理対象の 'トラック:チャンネル'、またはその配列（null なら全ノート）。対象外のノートは元のまま書き出す
   */
  function process(midi, mode, normalizeOpts, humanizeOpts, part) {
    if (mode !== 'humanize' && mode !== 'normalize') throw new Error('未対応のモードです: ' + mode);
    const split = MH.splitPart(midi, part);
    const out = mode === 'normalize' ? normalize(split.midi, normalizeOpts) : MH.humanize(split.midi, humanizeOpts);
    return Object.assign(out, { midi: MH.mergeOthers(out.midi, split.others) });
  }

  MH.normalize = normalize;
  MH.process = process;
})(typeof window !== 'undefined' ? window : globalThis);
