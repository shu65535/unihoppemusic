/**
 * MIDI編集モード: 一次データ（読み込んだMIDI）の加工対象パートのノートを直接書き換える（位置・長さ・音高・追加・削除・ノーマライズ）。
 * 画面には依存しない（モードの切り替え・履歴は ui/app.js）。
 *
 *   一次データ ──[ここで書き換え]──▶ 新しい一次データ ──▶ 分析し直し → ヒューマナイズ（ヒューマナイズ編集へ切り替えたとき）
 *
 * ユーザーの修正（手・ストローク方向・奏法・ヒューマナイズの修正値）はノートのキー（MH.noteKeyOf。元のMIDI上の開始位置で作る）で覚えているので、
 * 書き換えで変わったキーの対応（moves: [変更前のキー, 変更後のキー]）を返し、呼び出し側で付け替える（rekeyMaps）。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  /** 書き出して読み直した形にそろえる（イベントの並び順を書き出し・読み込みと同じにする。extractNotes は並び順で発音と消音を対にするため） */
  const canonical = (midi) => MH.parseMidi(MH.writeMidi(midi));

  /**
   * 一次データを表示・試聴・書き出し用の処理結果（MH.process の結果と同じ形）にする。ノートは加工しない。
   * 各ノートの key0 は、編集前のキー（書き換えたときのキーの付け替えに使う）
   * @param {object} [grid] 直近のノーマライズで判定した最小音価など（スナップのグリッドに使う）
   */
  function sourceView(midi, parts, grid) {
    const after = MH.extractNotes(MH.splitPart(midi, parts).midi).map((n) => Object.assign(n, { srcTick: n.tick }));
    for (const n of after) n.key0 = MH.noteKeyOf(n);
    return { midi, maps: MH.buildTimeMaps(midi), before: [], after, grid: grid || null, source: true };
  }

  /**
   * 加工対象パートのノートを notes に置き換えた一次データを作る。
   * 同じチャンネル・音高の重なりは、書き出しと同じく後の音が鳴る前に前の音を止めて解消する
   * @param {{track:number, ch:number, pitch:number, vel:number, offVel?:number, tick:number, endTick:number, key0?:string}[]} notes
   *   加工対象パートの全ノート（残すノート・追加したノート）。key0 は編集前のキー（追加したノートには無い）
   * @returns {{midi:object, moves:[string, string][]}} moves: 残したノートの [編集前のキー, 編集後のキー]
   */
  function applySourceNotes(midi, parts, notes) {
    if (!notes.length) throw new Error('ノートをすべて削除することはできません');
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
    const out = notes.map((n) => {
      const tick = Math.max(0, Math.round(n.tick));
      return {
        track: n.track,
        ch: n.ch,
        pitch: clamp(n.pitch, 0, 127),
        vel: clamp(n.vel, 1, 127),
        offVel: n.offVel,
        tick,
        endTick: Math.max(tick + 1, Math.round(n.endTick)),
        key0: n.key0,
      };
    });
    MH.resolveOverlaps(out); // 付け替え後のキーを確定させるため、applyEdits より先に解消しておく
    const next = canonical(MH.applyEdits(midi, { parts, notes: out }));
    const moves = out.filter((n) => n.key0 != null).map((n) => [n.key0, MH.handNoteKey(n, n.tick)]);
    return { midi: next, moves };
  }

  /**
   * 一次データの加工対象パートをノーマライズする（MH.normalize。範囲があれば範囲内だけ。範囲外は元のまま）
   * @param {{params:object, instrument?:string}} normOpts
   * @param {{start:number, end:number}|null} range
   * @returns {{midi:object, moves:[string, string][], shifts:{from:number, to:number}[], grid:object, mergedCount:number}}
   *   shifts: ノートごとの [元の開始位置 → ノーマライズ後の開始位置]（フレーズの区切りの付け替えに使う）。
   *   近すぎて1音にまとめられたノートは moves に入らない（そのノートの修正は消える）
   */
  function normalizeSource(midi, parts, normOpts, range) {
    const opts = Object.assign({}, normOpts, range ? { layers: [{ params: null }, { params: normOpts.params, range }] } : null);
    const res = MH.process(midi, 'normalize', opts, null, parts);
    const moves = [];
    const shifts = [];
    for (const n of res.after) {
      const from = n.origTick ?? n.tick;
      moves.push([MH.handNoteKey(n, from), MH.handNoteKey(n, n.tick)]);
      shifts.push({ from, to: n.tick });
    }
    return { midi: canonical(res.midi), moves, shifts, grid: res.grid || null, mergedCount: res.mergedCount || 0 };
  }

  /**
   * フレーズの区切り（元のMIDI上の位置）を、ノートの開始位置の動きに合わせて付け替える。
   * 区切りの位置以降で最初に始まるノートの、動いた後の位置にする（区切り以降に音が無ければそのまま）
   * @param {number[]|null} starts
   * @param {{from:number, to:number}[]} shifts
   */
  function remapStarts(starts, shifts) {
    if (!starts) return starts;
    const sorted = shifts.slice().sort((a, b) => a.from - b.from || a.to - b.to);
    const out = starts.map((s) => {
      const hit = sorted.find((x) => x.from >= s);
      return hit ? hit.to : s;
    });
    return [...new Set(out.map((t) => Math.max(0, Math.round(t))))].sort((a, b) => a - b);
  }

  /**
   * 抑揚のレーンに描いた点（元のMIDI上の位置）を、ノートの開始位置の動きに合わせて付け替える（remapStarts と同じ規則。値・スロープはそのまま）。
   * 同じ位置に重なった点は後ろの点を残す
   * @param {{tick:number, value:number, ramp?:boolean}[]|null} points
   * @param {{from:number, to:number}[]} shifts
   */
  function remapPoints(points, shifts) {
    if (!points) return points;
    const sorted = shifts.slice().sort((a, b) => a.from - b.from || a.to - b.to);
    const moved = points.map((p) => {
      const hit = sorted.find((x) => x.from >= p.tick);
      return Object.assign({}, p, { tick: Math.max(0, Math.round(hit ? hit.to : p.tick)) });
    });
    return moved.filter((p, i) => i === moved.length - 1 || moved[i + 1].tick !== p.tick);
  }

  /**
   * ノートのキーで引く Map の項目を付け替える（入れ替わり・連鎖した移動でも上書きしないよう、先にすべて取り出してから入れる）。
   * moves に無いキーのうち drop に含むものは消す（削除・まとめられたノート）
   * @param {Map<string, any>[]} maps
   * @param {[string, string][]} moves
   * @param {Iterable<string>} drop
   * @returns {[number, string, any][]} 消した項目（[Map の番号, キー, 値]。元に戻すときに restoreDropped で戻す）
   */
  function rekeyMaps(maps, moves, drop) {
    const dropped = [];
    const dropSet = new Set(drop);
    maps.forEach((m, i) => {
      const moved = [];
      for (const [from, to] of moves) {
        if (from === to || !m.has(from)) continue;
        moved.push([to, m.get(from)]);
        m.delete(from);
      }
      for (const k of dropSet) {
        if (!m.has(k)) continue;
        dropped.push([i, k, m.get(k)]);
        m.delete(k);
      }
      for (const [to, v] of moved) m.set(to, v);
    });
    return dropped;
  }

  /** rekeyMaps で消した項目を戻す */
  function restoreDropped(maps, dropped) {
    for (const [i, k, v] of dropped) maps[i].set(k, v);
  }

  /** moves を逆向きにする（元に戻すときの付け替え） */
  const invertMoves = (moves) => moves.map(([a, b]) => [b, a]);

  /**
   * 追加するノートのパート（トラック・チャンネル）。パートが2つ（ピアノの左手・右手が別パート）なら、平均音高が近い方
   * @param {object[]} notes 加工対象パートの今のノート
   * @param {string|string[]} parts 'トラック:チャンネル'
   * @returns {{track:number, ch:number}}
   */
  function partFor(notes, parts, pitch) {
    const keys = [].concat(parts);
    const avg = (key) => {
      const ns = notes.filter((n) => n.track + ':' + n.ch === key);
      return ns.length ? ns.reduce((a, n) => a + n.pitch, 0) / ns.length : null;
    };
    let best = keys[0];
    let bestD = Infinity;
    for (const key of keys) {
      const a = avg(key);
      const d = a == null ? Infinity : Math.abs(a - pitch);
      if (d < bestD) {
        best = key;
        bestD = d;
      }
    }
    const [track, ch] = best.split(':').map(Number);
    return { track, ch };
  }

  /** 追加するノートのベロシティ: 開始位置が最も近いノートのもの（ノートが無ければ 80） */
  function velocityNear(notes, tick) {
    let best = null;
    for (const n of notes) if (!best || Math.abs(n.tick - tick) < Math.abs(best.tick - tick)) best = n;
    return best ? best.vel : 80;
  }

  MH.sourceView = sourceView;
  MH.applySourceNotes = applySourceNotes;
  MH.normalizeSource = normalizeSource;
  MH.remapStarts = remapStarts;
  MH.remapPoints = remapPoints;
  MH.rekeyMaps = rekeyMaps;
  MH.restoreDropped = restoreDropped;
  MH.invertMoves = invertMoves;
  MH.partFor = partFor;
  MH.velocityNear = velocityNear;
})(typeof window !== 'undefined' ? window : globalThis);
