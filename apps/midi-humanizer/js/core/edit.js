/**
 * 処理結果に対する手動編集（加工後ノートの位置・長さ、CC・ピッチベンドのレーン）を書き出し用のMIDIに反映する。
 * ノートの位置・長さの修正は、ノートごとの修正値（ヒューマナイズ後からのずれ）としても持ち、処理し直したときは最後に足し込む（applyNoteOffsets）。
 * レーンの識別子: 'cc<番号>'（例 'cc64'）またはピッチベンドの 'pb'。値は CC が 0〜127、ピッチベンドが -8192〜8191。
 * 点に ramp: true があれば、直前の点からその点までを直線（スロープ）でつなぐ。MIDIに直線は無いため、書き出し・試聴では間を細かい点で補う。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const PB = 0xe0;
  const PB_CENTER = 8192;

  /** レーンの対象になるイベント（CC・ピッチベンド）なら識別子と値を返す */
  function laneOf(e) {
    if (e.kind !== 'ch') return null;
    if (e.status === MH.STATUS.CC) return { id: 'cc' + e.d1, value: e.d2 };
    if (e.status === PB) return { id: 'pb', value: ((e.d2 << 7) | e.d1) - PB_CENTER };
    return null;
  }

  /**
   * 対象パートのチャンネルに属するCC・ピッチベンドを判定する関数を作る。
   * 対象外パート（ノートのある他のトラック:チャンネル）のイベントは含めない
   * @param {string|string[]|null} parts 'トラック:チャンネル'（null なら全チャンネル）
   * @param {Set<string>} [ids] 対象のレーン（省略時はすべて）
   */
  function laneFilter(midi, parts, ids) {
    const isLane = (e) => {
      const l = laneOf(e);
      return !!l && (!ids || ids.has(l.id));
    };
    if (parts == null) return (ti, e) => isLane(e);
    const targets = new Set(Array.isArray(parts) ? parts : [parts]);
    const channels = new Set([...targets].map((k) => Number(k.split(':')[1])));
    const others = new Set(MH.listParts(midi).map((p) => p.key).filter((k) => !targets.has(k)));
    return (ti, e) => isLane(e) && channels.has(e.ch) && !others.has(ti + ':' + e.ch);
  }

  /**
   * 対象パートのCC・ピッチベンドをレーンごとに取り出す。
   * 左手・右手が別チャンネルのときは同じ位置・同じ値の点を1つにまとめる
   * @returns {Object<string, {tick:number, value:number}[]>} 位置の昇順
   */
  function extractLanes(midi, parts) {
    const match = laneFilter(midi, parts);
    const lanes = {};
    const seen = new Set();
    midi.tracks.forEach((t, ti) => {
      for (const e of t.events) {
        if (!match(ti, e)) continue;
        const { id, value } = laneOf(e);
        const key = id + ':' + e.tick + ':' + value;
        if (seen.has(key)) continue;
        seen.add(key);
        (lanes[id] = lanes[id] || []).push({ tick: e.tick, value });
      }
    });
    for (const list of Object.values(lanes)) list.sort((a, b) => a.tick - b.tick);
    return lanes;
  }

  /**
   * スロープ（ramp: true の点）の区間を、値が1変わる位置ごとの点で補った点の列を返す（ramp は外す）。
   * 点が詰まりすぎないよう、補う点どうし・両端の点との間隔は minGap 以上空ける
   * @param {{tick:number, value:number, ramp?:boolean}[]} points 位置の昇順
   * @param {number} minGap tick
   */
  function expandRamps(points, minGap) {
    const out = [];
    points.forEach((b, i) => {
      const a = points[i - 1];
      if (b.ramp && a) {
        const dt = b.tick - a.tick;
        const dv = b.value - a.value;
        const steps = Math.abs(Math.round(dv));
        let last = a.tick;
        let lastV = Math.round(a.value);
        for (let k = 1; k < steps; k++) {
          const tick = a.tick + Math.round((dt * k) / steps);
          if (tick - last < minGap || b.tick - tick < minGap) continue;
          const value = Math.round(a.value + (dv * (tick - a.tick)) / dt);
          if (value === lastV) continue;
          out.push({ tick, value });
          last = tick;
          lastV = value;
        }
      }
      out.push({ tick: b.tick, value: b.value });
    });
    return out;
  }

  /**
   * レーンの点の列の、位置 tick の値（点の間は前の点の値のまま。スロープの点へは直線）。最初の点より前は最初の点の値、点が無ければ0
   * @param {{tick:number, value:number, ramp?:boolean}[]} points 位置の昇順
   */
  function laneValueAt(points, tick) {
    if (!points || !points.length) return 0;
    let lo = -1;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (points[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    if (lo < 0) return points[0].value;
    const a = points[lo];
    const b = points[lo + 1];
    if (!b || !b.ramp || b.tick <= a.tick) return a.value;
    return a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
  }

  /**
   * 抑揚のレーンの自動の値: ヒューマナイズが記録した山なりの分（arcVel）を、元のMIDI上の位置の点の列にする。
   * 抑揚のレーンの値として使う音（arcMain。ピアノは旋律）の値を取り、無ければすべての音から取る。
   * 点の間を直線（スロープ）でつないだとき、どの音の位置でも元の値との差が tol 以内に収まるよう点を間引く（点の値は整数に丸めるので、差は最大 tol + 0.5）
   * @param {{srcTick?:number, tick:number, arcVel?:number, arcMain?:boolean}[]} notes
   * @param {[number, number]} range 値の範囲
   * @returns {{tick:number, value:number, ramp?:boolean}[]}
   */
  function autoExpressionPoints(notes, range, tol = 0.5) {
    const withArc = notes.filter((n) => n.arcVel != null);
    const main = withArc.filter((n) => n.arcMain);
    const src = (main.length ? main : withArc).map((n) => ({ tick: Math.round(n.srcTick ?? n.tick), value: n.arcVel })).sort((a, b) => a.tick - b.tick);
    const pts = src.filter((p, i) => !i || p.tick !== src[i - 1].tick);
    if (!pts.length) return [];
    // 両端を結ぶ直線から最も離れた点を残し、左右に分けて繰り返す（値の方向の差で測る）
    const keep = new Set([0, pts.length - 1]);
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      const a = pts[i0];
      const b = pts[i1];
      let worst = -1;
      let worstD = tol;
      for (let i = i0 + 1; i < i1; i++) {
        const v = a.value + ((b.value - a.value) * (pts[i].tick - a.tick)) / (b.tick - a.tick || 1);
        const d = Math.abs(pts[i].value - v);
        if (d > worstD) {
          worst = i;
          worstD = d;
        }
      }
      if (worst < 0) continue;
      keep.add(worst);
      stack.push([i0, worst], [worst, i1]);
    }
    const [lo, hi] = range;
    return [...keep]
      .sort((x, y) => x - y)
      .map((i, k) => Object.assign({ tick: pts[i].tick, value: Math.max(lo, Math.min(hi, Math.round(pts[i].value))) }, k ? { ramp: true } : {}));
  }

  /**
   * 抑揚のレーンの今の値 cur に、新しい値 next を範囲 spans の中だけ混ぜた点の列を返す（区間の設定を変えて処理し直したとき。元の配列は変更しない）。
   * 範囲内の値は cur と next の両方の点の位置で cur × (1 − weight) + next × weight（0.5 なら平均、1 なら next に置き換え）。点の間はスロープでつなぐ。
   * 範囲の外の値は cur のまま（範囲の始まりの1つ前と、範囲の終わりに cur の値の点を置く。始まりの手前は最大1tickのずれ）
   * @param {{tick:number, value:number, ramp?:boolean}[]} cur
   * @param {{tick:number, value:number, ramp?:boolean}[]} next
   * @param {{start:number, end:number}[]} spans 元のMIDI上の範囲（end は含まない。Infinity でもよい）
   * @param {number} weight
   * @param {[number, number]} range 値の範囲
   */
  function blendLanePoints(cur, next, spans, weight, range) {
    // 隣り合う範囲はまとめる
    const merged = [];
    for (const s of spans.slice().sort((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else merged.push({ start: s.start, end: s.end });
    }
    const inSpan = (t) => merged.some((s) => t >= s.start && t < s.end);
    const clamp = (v) => Math.max(range[0], Math.min(range[1], Math.round(v)));
    const out = new Map(); // tick → 点（同じ位置は後から置いたもの）
    for (const p of cur) if (!inSpan(p.tick)) out.set(p.tick, Object.assign({}, p));
    for (const s of merged) {
      // 範囲の手前が範囲内の点へのスロープだった所を、範囲の外では元の値のままにする
      const before = s.start - 1;
      if (before >= 0 && cur.some((p) => p.tick < s.start) && !out.has(before) && !inSpan(before)) {
        out.set(before, { tick: before, value: clamp(laneValueAt(cur, before)), ramp: true });
      }
      const ticks = new Set([s.start]);
      for (const p of cur.concat(next)) {
        if (p.tick < s.start || p.tick >= s.end) continue;
        ticks.add(p.tick);
        if (!p.ramp && p.tick > s.start) ticks.add(p.tick - 1); // ステップの点は、1つ前の位置まで前の値を保つ（点の間はスロープでつなぐため）
      }
      if (s.end !== Infinity && s.end - 1 > s.start) ticks.add(s.end - 1);
      for (const t of [...ticks].sort((a, b) => a - b)) {
        const value = clamp(laneValueAt(cur, t) * (1 - weight) + laneValueAt(next, t) * weight);
        out.set(t, Object.assign({ tick: t, value }, t !== s.start ? { ramp: true } : {}));
      }
      // 範囲の終わりから元の値に戻す
      if (s.end !== Infinity && !inSpan(s.end)) {
        const p = Object.assign({}, out.get(s.end) || { tick: s.end, value: clamp(laneValueAt(cur, s.end)) });
        delete p.ramp;
        out.set(s.end, p);
      }
    }
    return [...out.values()].sort((a, b) => a.tick - b.tick);
  }

  /**
   * 2つのレーンの点の列が範囲 spans の中で同じ値か（両方の点の位置で比べる。差が tol 未満なら同じ）
   */
  function sameLaneIn(a, b, spans, tol = 0.5) {
    const ticks = a.concat(b).map((p) => p.tick).concat(spans.map((s) => s.start));
    return ticks.every((t) => !spans.some((s) => t >= s.start && t < s.end) || Math.abs(laneValueAt(a, t) - laneValueAt(b, t)) < tol);
  }

  /**
   * 編集内容を反映したMIDIを作る（元の midi は変更しない）。
   * @param {{parts:string|string[]|null, notes?:object[]|null, lanes?:Object<string,{tick:number,value:number}[]>|null}} edit
   *   notes: 対象パートの加工後ノート（null なら元のまま）。
   *   lanes: 差し替えるレーンとその点（含まれないレーンのイベントは元のまま。null なら全レーン元のまま）。スロープは細かい点にして書く
   */
  function applyEdits(midi, edit) {
    const notes = edit.notes ? edit.notes.map((n) => Object.assign({}, n)) : null;
    const isTarget = edit.parts == null ? () => true : ((s) => (key) => s.has(key))(new Set([].concat(edit.parts)));
    const laneMatch = edit.lanes ? laneFilter(midi, edit.parts, new Set(Object.keys(edit.lanes))) : () => false;
    const isNote = (e) => e.kind === 'ch' && (e.status === MH.STATUS.NOTE_ON || e.status === MH.STATUS.NOTE_OFF);
    const tracks = midi.tracks.map((t, ti) => ({
      endTick: t.endTick,
      events: t.events.filter((e) => !(notes && isNote(e) && isTarget(ti + ':' + e.ch)) && !laneMatch(ti, e)),
    }));

    if (notes) {
      for (const n of notes) {
        n.tick = Math.max(0, Math.round(n.tick));
        n.endTick = Math.max(n.tick + 1, Math.round(n.endTick));
      }
      MH.resolveOverlaps(notes);
      for (const n of notes) {
        const t = tracks[n.track];
        t.events.push({ tick: n.tick, kind: 'ch', status: MH.STATUS.NOTE_ON, ch: n.ch, d1: n.pitch, d2: n.vel });
        t.events.push({ tick: n.endTick, kind: 'ch', status: MH.STATUS.NOTE_OFF, ch: n.ch, d1: n.pitch, d2: n.offVel == null ? 64 : n.offVel });
        t.endTick = Math.max(t.endTick, n.endTick);
      }
    }

    if (edit.lanes) {
      // 書き込み先: 対象チャンネルごとに、そのチャンネルのノートが最も多いトラック（ヒューマナイズのCCと同じ規則）
      const count = new Map();
      for (const n of notes || MH.extractNotes(midi)) {
        const key = n.track + ':' + n.ch;
        if (isTarget(key)) count.set(key, (count.get(key) || 0) + 1);
      }
      const dest = new Map(); // ch → track
      for (const [key] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
        const [track, ch] = key.split(':').map(Number);
        if (!dest.has(ch)) dest.set(ch, track);
      }
      for (const [id, points] of Object.entries(edit.lanes)) {
        for (const p of expandRamps(points, rampGap(midi.ppq))) {
          const tick = Math.max(0, Math.round(p.tick));
          for (const [ch, track] of dest) {
            const t = tracks[track];
            if (id === 'pb') {
              const v = Math.max(0, Math.min(16383, Math.round(p.value) + PB_CENTER));
              t.events.push({ tick, kind: 'ch', status: PB, ch, d1: v & 0x7f, d2: v >> 7 });
            } else {
              const v = Math.max(0, Math.min(127, Math.round(p.value)));
              t.events.push({ tick, kind: 'ch', status: MH.STATUS.CC, ch, d1: Number(id.slice(2)), d2: v });
            }
            t.endTick = Math.max(t.endTick, tick);
          }
        }
      }
    }
    return { format: midi.format, ppq: midi.ppq, tracks };
  }

  /** スロープを補う点の最小間隔（16分音符の1/8） */
  const rampGap = (ppq) => Math.max(1, Math.round(ppq / 32));

  /**
   * ツールバーのグリッドの値（'1/16'、3連は '1/8T' など）の長さ（tick）
   * @returns {number|null} 対応しない値なら null
   */
  function snapGridTicks(ppq, value) {
    const m = /^1\/(1|2|4|8|16|32)(T?)$/.exec(value || '');
    if (!m) return null;
    return ((ppq * 4) / Number(m[1])) * (m[2] ? 2 / 3 : 1);
  }

  /**
   * レーンの点のうち、位置が from〜to（両端を含む）のものを除いて add の点を加え、位置の昇順に並べた新しい配列を返す（元の配列は変更しない）。
   * 鉛筆・ラインで描いた区間の点を差し替えるのに使う
   */
  function replacePoints(points, from, to, add) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    return points
      .filter((c) => c.tick < lo || c.tick > hi)
      .concat(add)
      .sort((a, b) => a.tick - b.tick);
  }

  /**
   * ラインツールで引いた直線の点（始点＝ステップ、終点＝スロープ）。左へ引いたときも位置の昇順にする。
   * 始点と終点が同じ位置なら、終点の1点だけ
   */
  function linePoints(t0, v0, t1, v1) {
    if (t0 === t1) return [{ tick: t1, value: v1 }];
    const [a, b] = t0 < t1 ? [[t0, v0], [t1, v1]] : [[t1, v1], [t0, v0]];
    return [{ tick: a[0], value: a[1] }, { tick: b[0], value: b[1], ramp: true }];
  }

  /** ノートのキー（元のMIDI上の開始位置で識別する。正規化・ヒューマナイズの設定を変えても外れない） */
  const noteKeyOf = (n) => MH.handNoteKey(n, n.srcTick ?? n.origTick ?? n.tick);

  /**
   * ユーザーの修正値（開始位置・長さのずれ）をノートに足す。処理の最後（ノーマライズ→ヒューマナイズの後）に行う。
   * 各ノートに修正前の値 baseTick・baseEnd と、修正値 userOffset・修正値があるか userEdited を付ける。notes を直接書き換える。
   * 丸め・重なり解消（finalize）の後に settleNoteBases で修正前の値を確定し直す
   * @param {Map<string,{dt:number, dl:number}>} [offsets] noteKeyOf → 修正値（dt: 開始位置、dl: 長さ。tick）
   */
  function applyNoteOffsets(notes, offsets) {
    for (const n of notes) {
      n.baseTick = Math.max(0, Math.round(n.tick));
      n.baseEnd = Math.max(n.baseTick + 1, Math.round(n.endTick));
      const o = offsets && offsets.get(noteKeyOf(n));
      n.userOffset = o ? { dt: o.dt, dl: o.dl } : null;
      n.userEdited = !!o;
      if (o) setNoteOffset(n, o);
    }
    return notes;
  }

  /**
   * 丸め・重なり解消の後の位置・長さから、修正前の値を確定し直す（修正値の分を差し引く）。
   * 確定し直さないと、重なり解消で切り詰められただけのノートも「修正あり」と判定され、ドラッグした修正値に補正分が混ざる
   */
  function settleNoteBases(notes) {
    for (const n of notes) {
      if (n.baseTick == null) continue;
      const o = n.userOffset;
      n.baseTick = Math.max(0, n.tick - (o ? o.dt : 0));
      n.baseEnd = n.baseTick + Math.max(1, n.endTick - n.tick - (o ? o.dl : 0));
      delete n.userOffset;
    }
  }

  /** 修正前の値に修正値を足した位置・長さにする（o が null なら修正前の値に戻す） */
  function setNoteOffset(n, o) {
    n.tick = Math.max(0, n.baseTick + (o ? o.dt : 0));
    n.endTick = n.tick + Math.max(1, n.baseEnd - n.baseTick + (o ? o.dl : 0));
    n.userEdited = !!o;
  }

  /** ノートの今の位置・長さを修正前の値と比べた修正値（同じなら null） */
  function noteOffsetOf(n) {
    const dt = Math.round(n.tick) - n.baseTick;
    const dl = Math.round(n.endTick - n.tick) - (n.baseEnd - n.baseTick);
    return dt || dl ? { dt, dl } : null;
  }

  MH.noteKeyOf = noteKeyOf;
  MH.applyNoteOffsets = applyNoteOffsets;
  MH.settleNoteBases = settleNoteBases;
  MH.setNoteOffset = setNoteOffset;
  MH.noteOffsetOf = noteOffsetOf;
  MH.snapGridTicks = snapGridTicks;
  MH.replacePoints = replacePoints;
  MH.linePoints = linePoints;
  MH.extractLanes = extractLanes;
  MH.expandRamps = expandRamps;
  MH.laneValueAt = laneValueAt;
  MH.autoExpressionPoints = autoExpressionPoints;
  MH.blendLanePoints = blendLanePoints;
  MH.sameLaneIn = sameLaneIn;
  // 抑揚のレーンの値の範囲（ベロシティに足す量）
  MH.EXPRESSION_RANGE = [-64, 63];
  MH.rampGap = rampGap;
  MH.applyEdits = applyEdits;
})(typeof window !== 'undefined' ? window : globalThis);
