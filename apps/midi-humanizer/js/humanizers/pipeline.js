/**
 * ヒューマナイズ処理の入口と、正規化とも共通の後処理（範囲制限・重なり解消・MIDI再構築・統計）。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  /**
   * @param {object} midi parseMidi の結果
   * @param {{instrument:'piano'|'guitar'|'drums', params:object, seed:string|number, intensity:number, drumMap?:object,
   *   hands?:{parts?:Object<string,'R'|'L'>, overrides?:Map<string,'R'|'L'>, fixed?:Map<string,'R'|'L'>}, strums?:{overrides?:Map<string,'D'|'U'>, fixed?:Map<string,'D'|'U'>}, phrases?:number[]|null, noteOffsets?:Map<string,{dt:number, dl:number}>}} opts
   *   hands はピアノの手の指定（core/hands.js の assignHands を参照）。strums はギターのストローク方向の指定（overrides: ユーザーの修正、fixed: 判定済みの方向。どちらも Map<ノートのキー, 'D'|'U'>。humanizers/guitar.js を参照）。phrases はフレーズの区切り（元のMIDI上の位置。省略・null なら検出する。core/analysis.js の detectPhrases を参照）。noteOffsets はユーザーの修正値（core/edit.js の applyNoteOffsets を参照）
   *   判定済みの値が無いノートは、ヒューマナイズの前に分析する（core/analyze.js の analyzeNotes。結果は戻り値の analysis）
   *   layers（省略可）: 範囲ごとに重ねるヒューマナイズ [{seed, params, intensity, drumMap?, range?:{start, end}}]。
   *   ノート・CC・ピッチベンドは、その位置（ヒューマナイズ前の tick）を範囲に含む最後のレイヤーの結果を使う。
   *   先頭のレイヤーは範囲によらず全体。省略時は opts の seed・params・intensity・drumMap の1レイヤー
   *   画面の「区間」は、重ならず隙間なく並べたレイヤー（splitSections を参照）
   *   main（省略可）: 判定の設定・戻り値の params・phraseStarts に使うレイヤーの添字（直近に実行した区間。省略時は最後のレイヤー）
   *   expression（省略可）: 抑揚のレーンに描いた点の列（元のMIDI上の位置。core/edit.js の laneValueAt を参照）。あれば抑揚（自動）の山なりの代わりに使う（applyExpression）。
   *   戻り値の exprAuto は抑揚のレーンの自動の値（描いていないときにレーンに出す。autoExpressionPoints を参照）
   */
  function humanize(midi, opts) {
    const humanizer = MH.humanizers[opts.instrument];
    if (!humanizer) throw new Error('未対応の楽器です: ' + opts.instrument);
    const maps = MH.buildTimeMaps(midi);
    const before = MH.extractNotes(midi);
    if (!before.length) throw new Error('ノートが含まれていません');
    const notes = prepareNotes(midi, before);
    const layers = opts.layers && opts.layers.length ? opts.layers : [{ seed: opts.seed, params: opts.params, intensity: opts.intensity, drumMap: opts.drumMap }];
    // 分析（core/analyze.js）。判定済みの値（opts.hands.fixed など）が無いノートだけ判定する。判定の設定は最後のレイヤーのもの
    const main = Math.min(opts.main ?? layers.length - 1, layers.length - 1);
    const analysis = MH.analyzeNotes(notes, maps, midi.ppq, opts.instrument, layers[main].params, { hands: opts.hands, strums: opts.strums, phrases: opts.phrases });
    const phrases = opts.phrases || analysis.phrases || null;
    const runLayer = (layer) => {
      const params = Object.assign({}, MH.defaultParams(opts.instrument), layer.params || {});
      const rng = MH.createRng(layer.seed == null ? 1 : layer.seed);
      const ctx = { maps, rng, k: layer.intensity == null ? 1 : layer.intensity, ppq: midi.ppq, drumMap: layer.drumMap, hands: opts.hands, strums: opts.strums, phrases, analysis };
      const res = humanizer(notes.map((n) => Object.assign({}, n)), ctx, params);
      if (opts.expression) applyExpression(res.notes, opts.expression);
      // ベロシティ基準「相対」: 元のベロシティが基準値（humanizer がノートごとに velRef に記録）からずれた分を足す
      if (params.velRef === 'relative') for (const n of res.notes) if (n.velRef != null) n.vel += n.srcVel - n.velRef;
      return Object.assign(res, { params });
    };
    const res = layers.length === 1 ? runLayer(layers[0]) : mergeLayers(layers, layers.map(runLayer), notes, main);
    const params = res.params;
    // ユーザーの修正値（開始位置・長さ）を最後に足す
    MH.applyNoteOffsets(res.notes, opts.noteOffsets);

    // CCの出力先: チャンネルごとに、そのチャンネルのノートが最も多いトラック
    // （ピアノの左手・右手が別チャンネルでも、両方にペダルが掛かるように）
    const count = new Map();
    for (const n of res.notes) {
      const key = n.track + ':' + n.ch;
      count.set(key, (count.get(key) || 0) + 1);
    }
    const dest = new Map(); // ch → track
    for (const [key] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
      const [track, ch] = key.split(':').map(Number);
      if (!dest.has(ch)) dest.set(ch, track);
    }
    const ccs = [];
    const pbs = [];
    for (const [ch, track] of dest) {
      for (const c of res.ccs) ccs.push(Object.assign({}, c, { track, ch }));
      for (const b of res.pbs || []) pbs.push(Object.assign({}, b, { track, ch }));
    }

    const out = finalize(midi, maps, before, res.notes, ccs, new Set(res.replaceCC), new Set(dest.keys()), pbs);
    out.params = params;
    // フレーズの区切り（元のMIDI上の位置）。範囲ごとのレイヤーがあれば最後のレイヤーのもの
    out.phraseStarts = res.phraseStarts;
    out.analysis = analysis;
    out.exprAuto = MH.autoExpressionPoints(res.notes, MH.EXPRESSION_RANGE);
    return out;
  }

  /**
   * 抑揚のレーンに描いた値を効かせる: humanizer が足した抑揚（自動）の山なりの分（arcVel）を、ノートの元のMIDI上の位置のレーンの値に置き換える。
   * 効かせる先は今はベロシティだけ（レーンの値をそのまま足す）。楽器固有の設定で先（CC など）と量を選べるようにするときはここを広げる
   */
  function applyExpression(notes, points) {
    // 山なりを付けていない音（arcVel が無い）には効かせない
    for (const n of notes) if (n.arcVel != null) n.vel += MH.laneValueAt(points, n.srcTick ?? n.tick) - n.arcVel;
  }

  /**
   * ヒューマナイズ・分析の入力にするノート（extractNotes の複製）に、元のMIDI上の開始位置 srcTick（ピアノの手・ギターのストローク方向の修正の識別に使う）を付ける
   * @param {object[]} [before] midi の extractNotes の結果（あれば使い回す）
   */
  function prepareNotes(midi, before) {
    return (before || MH.extractNotes(midi)).map((n) => Object.assign({}, n, { srcTick: n.tick }));
  }

  /**
   * レイヤーごとの結果を範囲で切り貼りする（humanize の layers を参照）。
   * CC・ピッチベンドは、受け持つレイヤーが変わる位置に、新しく受け持つレイヤーのその時点の値を置く（ペダルの踏みっぱなしなどを防ぐ）
   * @param {object[]} results レイヤーごとの humanizer の結果
   * @param {object[]} input ヒューマナイズ前のノート（範囲の判定に使う位置）
   */
  function mergeLayers(layers, results, input, main = results.length - 1) {
    const owner = ownerOf(layers);
    const inputTick = new Map(input.map((n) => [n.id, n.tick]));
    const notes = [];
    results.forEach((res, i) => {
      for (const n of res.notes) if (owner(inputTick.get(n.id) ?? n.tick) === i) notes.push(n);
    });

    // 受け持つレイヤーが変わる位置
    const edges = [...new Set(layers.slice(1).flatMap((l) => (l.range ? [l.range.start, l.range.end] : [])))].filter((t) => owner(t - 0.5) !== owner(t));
    // 種類ごとに、レイヤー i の t より前の最後の値（無ければ既定値。既定値の無い種類は置かない）
    const pick = (events, keyOf, defaults) => {
      const out = [];
      results.forEach((res, i) => {
        for (const e of res[events] || []) if (owner(e.tick) === i) out.push(e);
      });
      for (const t of edges) {
        const i = owner(t);
        const last = new Map();
        for (const e of results[i][events] || []) if (e.tick < t && (!last.has(keyOf(e)) || last.get(keyOf(e)).tick <= e.tick)) last.set(keyOf(e), e);
        const kinds = new Set(results.flatMap((res) => (res[events] || []).map(keyOf)));
        for (const k of kinds) {
          if ((results[i][events] || []).some((e) => keyOf(e) === k && e.tick === t)) continue;
          const e = last.get(k);
          const value = e ? e.value : defaults(k);
          if (value != null) out.push(Object.assign({}, e || (events === 'ccs' ? { cc: k } : {}), { tick: t, value }));
        }
      }
      return out;
    };
    const ccs = pick('ccs', (c) => c.cc, (cc) => (cc === 64 ? 0 : null));
    const pbs = pick('pbs', () => 'pb', () => 0);
    const replaceCC = [...new Set(results.flatMap((res) => res.replaceCC || []))];
    return { notes, ccs, pbs: pbs.sort((a, b) => a.tick - b.tick), replaceCC, params: results[main].params, phraseStarts: results[main].phraseStarts };
  }

  /**
   * 位置 t を受け持つレイヤー（範囲に t を含む最後のレイヤー。先頭のレイヤーは全体）を返す関数。
   * 区間の最後の end は Infinity なので、owner(Infinity) は 0 になる（mergeLayers の境目の判定では owner(t - 0.5) と同じになり、境目から外れる）
   */
  function ownerOf(layers) {
    const inRange = (r, t) => !r || (t >= r.start && t < r.end);
    return (t) => {
      for (let i = layers.length - 1; i > 0; i--) if (inRange(layers[i].range, t)) return i;
      return 0;
    };
  }

  /**
   * 区間ごとの範囲（ヒューマナイズ前の tick）。先頭の区間は 0 から、最後の区間は Infinity まで
   * @param {object[]} layers 区間（humanize の layers。先頭は range なし、2つ目以降は始まりの順）
   * @returns {{start:number, end:number}[]}
   */
  function sectionSpans(layers) {
    return layers.map((l, i) => ({ start: i ? l.range.start : 0, end: i + 1 < layers.length ? layers[i + 1].range.start : Infinity }));
  }

  /**
   * 位置 t を含む区間の添字（t が最後の区間より後でも最後の区間）
   * @param {object[]} layers 区間（sectionSpans を参照）
   * @param {number} t ヒューマナイズ前の tick
   */
  function sectionIndexAt(layers, t) {
    const i = sectionSpans(layers).findIndex((sp) => t < sp.end);
    return i < 0 ? layers.length - 1 : i;
  }

  /**
   * 範囲の中で結合する区間の範囲: 範囲の内側にある、消せる境目（fixed でない区間の始まり）の両側の区間をまとめた範囲
   * @param {{start:number, end:number, fixed?:boolean}[]} spans sectionSpans の結果（fixed は拍子の変わる位置の消せない境目）
   * @param {{start:number, end:number}} range
   * @returns {{start:number, end:number}|null} 消せる境目が無ければ null
   */
  function mergeSpan(spans, range) {
    let start = null;
    let end = null;
    spans.forEach((sp, i) => {
      if (!i || sp.fixed || sp.start <= range.start || sp.start >= range.end) return;
      if (start == null) start = spans[i - 1].start;
      end = sp.end;
    });
    return start == null ? null : { start, end };
  }

  /**
   * 区間を range で切り分け、range を新しい区間にする。range に掛かる区間は、範囲の外の部分だけを残す。
   * 残した部分の設定・シードは元のまま（各区間は曲全体で処理して受け持つ所だけを使うので、範囲の外の結果は変わらない）
   * @param {object[]} layers 今の区間（sectionSpans を参照）
   * @param {{start:number, end:number}} range 新しい区間（end は Infinity でもよい）
   * @param {object} section 新しい区間の設定 {seed, params, intensity, drumMap}
   * @returns {object[]} 区間（先頭は range なし、2つ目以降の range.end は次の区間の始まり。最後は Infinity）
   */
  function splitSections(layers, range, section) {
    const pieces = [];
    sectionSpans(layers).forEach(({ start, end }, i) => {
      if (start < range.start) pieces.push({ l: layers[i], start, end: Math.min(end, range.start) });
      if (end > range.end) pieces.push({ l: layers[i], start: Math.max(start, range.end), end });
    });
    pieces.push({ l: section, start: range.start, end: range.end });
    pieces.sort((a, b) => a.start - b.start);
    return pieces.map((p, i) => Object.assign({}, p.l, { range: i ? { start: p.start, end: p.end } : null }));
  }

  /**
   * 区間を ticks の位置で切り分ける（境目が既にある位置はそのまま）。切り分けた両側は元の区間の設定・シードのまま（結果は変わらない）。
   * 拍子の変わる位置に、結合しても消えない境目を置くのに使う
   * @param {object[]} layers 今の区間（sectionSpans を参照）
   * @param {number[]} ticks 切り分ける位置
   * @returns {object[]} 区間（splitSections と同じ形）
   */
  function splitAt(layers, ticks) {
    const pieces = [];
    sectionSpans(layers).forEach(({ start, end }, i) => {
      const cuts = [start, ...ticks.filter((t) => t > start && t < end).sort((a, b) => a - b)];
      cuts.forEach((s) => pieces.push({ l: layers[i], start: s }));
    });
    return pieces.map((p, i) => Object.assign({}, p.l, { range: i ? { start: p.start, end: i + 1 < pieces.length ? pieces[i + 1].start : Infinity } : null }));
  }

  /**
   * 新しい区間の終わり: 終わり以降に始まるノートが無ければ Infinity（後ろにノートの始まりが無い区間を作らない。伸ばした音の途中までの範囲も含む）
   * @param {number} end 区間の終わりの候補（beatRange で広げた範囲の終わり）
   * @param {{tick:number}[]} notes ヒューマナイズ前のノート
   */
  function sectionEnd(end, notes) {
    return notes.some((n) => n.tick >= end) ? end : Infinity;
  }

  /**
   * 範囲を外側の拍の区切りまで広げる（区間の最小単位は1拍。拍はピアノロールの拍線と同じ、拍子の拍）
   * @param {object} maps buildTimeMaps の結果
   * @param {{start:number, end:number}} range
   */
  function beatRange(maps, range) {
    const floor = (t) => {
      const p = maps.position(t);
      return p.barStartTick + p.beat * p.pulseTicks;
    };
    const ceil = (t) => {
      const f = floor(t);
      if (t - f < 1e-6) return f;
      const p = maps.position(f);
      return Math.min(f + p.pulseTicks, p.barStartTick + p.barTicks); // 半端な小節の終わりは小節線
    };
    const start = floor(Math.max(0, range.start));
    return { start, end: Math.max(ceil(range.end), ceil(start + 1)) };
  }

  /** MIDIのCC・ピッチベンド（tick順）。ピッチベンドは cc が null */
  function controllerEvents(midi) {
    const out = [];
    midi.tracks.forEach((t, track) => {
      for (const e of t.events) {
        if (e.kind !== 'ch') continue;
        if (e.status === MH.STATUS.CC) out.push({ tick: e.tick, cc: e.d1, value: e.d2, track, ch: e.ch });
        else if (e.status === MH.STATUS.PB) out.push({ tick: e.tick, cc: null, value: (e.d1 | (e.d2 << 7)) - 8192, track, ch: e.ch });
      }
    });
    return out.sort((a, b) => a.tick - b.tick);
  }

  // 受け持つレイヤーが変わる位置で、それより前に値の無い種類に置く値（無ければ置かない）
  const CONTROLLER_DEFAULTS = { pb: 0, 64: 0, 1: 0, 4: 0, 11: 127 };

  /**
   * 範囲ごとのレイヤーの処理結果（finalize の結果）を切り貼りして1つの結果にする（ノーマライズの範囲実行で使う）。
   * ノートは srcTickOf の位置（元のMIDI上の位置）、CC・ピッチベンドはその位置を受け持つレイヤーの結果を使う。
   * 受け持つレイヤーが変わる位置には、新しく受け持つレイヤーのその時点の値を置く（ペダルの踏みっぱなしなどを防ぐ）
   * @param {object} midi 元のMIDI（ノート・CC・ピッチベンド以外のイベントはここから取る）
   * @param {{range?:{start:number, end:number}}[]} layers
   * @param {{midi:object, after:object[]}[]} results レイヤーごとの処理結果
   * @param {object[][]} inputs レイヤーごとの処理の入力ノート（統計のずれ量の基準。id で after と対応する）
   * ノートの受け持ちは元の位置、CC・ピッチベンドは処理後の位置で決める（範囲の端の近くでは、ノートとCCの受け持ちがずれることがある）
   */
  function mergeResults(midi, layers, results, inputs, srcTickOf) {
    const owner = ownerOf(layers);
    const notes = [];
    const statBefore = []; // 統計の基準。レイヤーごとに id が重なるので振り直す
    results.forEach((r, i) => {
      const input = new Map(inputs[i].map((n) => [n.id, n]));
      for (const n of r.after) {
        if (owner(srcTickOf(n)) !== i) continue;
        const id = notes.length;
        notes.push(Object.assign({}, n, { id }));
        statBefore.push(Object.assign({}, input.get(n.id) || n, { id }));
      }
    });
    const kindOf = (e) => e.track + ':' + e.ch + ':' + (e.cc == null ? 'pb' : e.cc);
    const events = results.map((r) => controllerEvents(r.midi));
    const ctl = [];
    events.forEach((list, i) => {
      for (const e of list) if (owner(e.tick) === i) ctl.push(e);
    });
    const kinds = new Map();
    for (const list of events) for (const e of list) kinds.set(kindOf(e), e);
    const edges = [...new Set(layers.slice(1).flatMap((l) => (l.range ? [l.range.start, l.range.end] : [])))].filter((t) => owner(t - 0.5) !== owner(t));
    for (const t of edges) {
      const list = events[owner(t)];
      const last = new Map();
      for (const e of list) if (e.tick < t) last.set(kindOf(e), e);
      const at = new Set(list.filter((e) => e.tick === t).map(kindOf));
      for (const [k, e0] of kinds) {
        if (at.has(k)) continue;
        const value = last.has(k) ? last.get(k).value : CONTROLLER_DEFAULTS[e0.cc == null ? 'pb' : e0.cc];
        if (value != null) ctl.push(Object.assign({}, e0, { tick: t, value }));
      }
    }
    // 元のMIDIのCC・ピッチベンドはすべて消し、切り貼りしたものを書き込む
    const all = controllerEvents(midi).concat(...events);
    const replaceCC = new Set(all.map((e) => (e.cc == null ? 'pb' : e.cc)));
    const channels = new Set(all.map((e) => e.ch));
    return finalize(
      midi,
      MH.buildTimeMaps(midi),
      statBefore,
      notes,
      ctl.filter((e) => e.cc != null),
      replaceCC,
      channels,
      ctl.filter((e) => e.cc == null)
    );
  }

  /**
   * 値の丸め・範囲制限・同音の重なり解消を行い、MIDIを再構築する。
   * @param {Set<number|'pb'>} replaceCC 既存イベントを削除するCC番号（'pb' ならピッチベンド）
   * @param {Set<number>} replaceChannels 上記の削除対象チャンネル
   * @param {{tick:number, value:number, track:number, ch:number}[]} [pbsIn] 書き込むピッチベンド
   */
  function finalize(midi, maps, before, notes, ccsIn, replaceCC, replaceChannels, pbsIn = []) {
    const minLen = Math.max(1, Math.round(midi.ppq / 64));
    for (const n of notes) {
      n.vel = Math.max(1, Math.min(127, Math.round(n.vel)));
      n.tick = Math.max(0, Math.round(n.tick));
      n.endTick = Math.max(n.tick + minLen, Math.round(n.endTick));
    }
    resolveOverlaps(notes);
    MH.settleNoteBases(notes); // ユーザーの修正値を足したノートの、修正前の値を確定する
    const ccs = ccsIn
      .map((c) => ({ tick: Math.max(0, Math.round(c.tick)), cc: c.cc, value: Math.max(0, Math.min(127, Math.round(c.value))), track: c.track, ch: c.ch }))
      .sort((a, b) => a.tick - b.tick);
    const pbs = pbsIn.map((b) => ({ tick: Math.max(0, Math.round(b.tick)), value: Math.max(-8192, Math.min(8191, Math.round(b.value))), track: b.track, ch: b.ch }));

    const out = MH.rebuildMidi(midi, notes, ccs, replaceCC, replaceChannels, pbs);
    return { midi: out, maps, before, after: notes, ccs, pbs, stats: computeStats(before, notes, maps) };
  }

  /** 同じチャンネル・音高の重なりを解消する（後の音が鳴る前に前の音を止める。同時刻なら後の音を1tickずらす）。notes を直接書き換える */
  function resolveOverlaps(notes) {
    const groups = new Map();
    for (const n of notes) {
      const key = n.ch + ':' + n.pitch;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    for (const g of groups.values()) {
      g.sort((a, b) => a.tick - b.tick);
      for (let i = 0; i < g.length - 1; i++) {
        const cur = g[i];
        const next = g[i + 1];
        if (next.tick <= cur.tick) next.tick = cur.tick + 1;
        if (next.endTick <= next.tick) next.endTick = next.tick + 1;
        if (cur.endTick > next.tick) cur.endTick = next.tick;
      }
    }
  }

  function computeStats(before, after, maps) {
    const byId = new Map(before.map((n) => [n.id, n]));
    const vels = after.map((n) => n.vel);
    const mean = vels.reduce((a, b) => a + b, 0) / vels.length;
    const sd = Math.sqrt(vels.reduce((a, b) => a + (b - mean) ** 2, 0) / vels.length);
    const shifts = after.map((n) => maps.tickToMs(n.tick) - maps.tickToMs(byId.get(n.id).tick));
    const absShift = shifts.map(Math.abs);
    return {
      notes: after.length,
      velMin: MH.minOf(vels, (v) => v),
      velMax: MH.maxOf(vels, (v) => v),
      velMean: mean,
      velSd: sd,
      shiftMeanAbsMs: absShift.reduce((a, b) => a + b, 0) / absShift.length,
      shiftMaxAbsMs: MH.maxOf(absShift, (v) => v),
    };
  }

  MH.humanize = humanize;
  MH.prepareNotes = prepareNotes;
  MH.finalize = finalize;
  MH.mergeResults = mergeResults;
  MH.sectionSpans = sectionSpans;
  MH.sectionIndexAt = sectionIndexAt;
  MH.mergeSpan = mergeSpan;
  MH.sectionEnd = sectionEnd;
  MH.splitSections = splitSections;
  MH.splitAt = splitAt;
  MH.beatRange = beatRange;
  MH.resolveOverlaps = resolveOverlaps;
})(typeof window !== 'undefined' ? window : globalThis);
