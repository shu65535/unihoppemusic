/**
 * Standard MIDI File (SMF) の読み込み・書き出し。外部ライブラリ不使用。
 * ブラウザ（file:// 直開き）と Node の両方で動くよう、グローバル名前空間 MH に登録する。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const STATUS = { NOTE_OFF: 0x80, NOTE_ON: 0x90, CC: 0xb0, PB: 0xe0 };

  // 可変長整数（最大4バイト）。ビット演算は使わず、5バイト以上や途中切れは不正として扱う
  function readVLQ(bytes, pos, end) {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= end) throw new Error('MIDIデータが途中で終わっています');
      const b = bytes[pos++];
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) return [value, pos];
    }
    throw new Error('不正な可変長整数です');
  }

  function writeVLQ(value, out) {
    if (!Number.isFinite(value) || value < 0 || value > 0x0fffffff) throw new Error('書き出せない時間値です: ' + value);
    const stack = [value & 0x7f];
    value >>>= 7;
    while (value > 0) {
      stack.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
  }

  /**
   * @param {ArrayBuffer|Uint8Array} buf
   * @returns {{format:number, ppq:number, tracks:{events:object[], endTick:number}[]}}
   */
  function parseMidi(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let p = 0;
    const str = (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]);
      return s;
    };
    const u32 = () => {
      const v = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      p += 4;
      return v;
    };
    const u16 = () => {
      const v = (b[p] << 8) | b[p + 1];
      p += 2;
      return v;
    };

    if (b.length < 14 || str(4) !== 'MThd') throw new Error('MIDIファイルではありません（MThdヘッダがありません）');
    p += 4;
    const headerLen = u32();
    const headerStart = p;
    const format = u16();
    const ntrks = u16();
    const division = u16();
    p = headerStart + headerLen;
    if (headerLen < 6) throw new Error('MIDIヘッダが不正です');
    if (format > 1) throw new Error('フォーマット2のMIDIには未対応です');
    if (division & 0x8000) throw new Error('SMPTE形式のタイムベースには未対応です');
    if (division === 0) throw new Error('分解能（PPQ）が0です');

    const tracks = [];
    while (p + 8 <= b.length && tracks.length < ntrks) {
      const id = str(4);
      p += 4;
      const len = u32();
      const end = Math.min(p + len, b.length);
      if (id !== 'MTrk') {
        p = end;
        continue;
      }
      const events = [];
      let tick = 0;
      let running = 0;
      let endTick = 0;
      const need = (n) => {
        if (p + n > end) throw new Error('MIDIトラックが途中で終わっています');
      };
      while (p < end) {
        let delta;
        [delta, p] = readVLQ(b, p, end);
        tick += delta;
        if (tick > 0x0fffffff) throw new Error('曲が長すぎます');
        need(1);
        let status = b[p];
        if (status < 0x80) {
          if (!running) throw new Error('不正なランニングステータスです');
          status = running;
        } else {
          p++;
          // SMF仕様: メタ/SysExはランニングステータスを解除する
          running = status < 0xf0 ? status : 0;
        }

        if (status === 0xff) {
          need(1);
          const type = b[p++];
          let mlen;
          [mlen, p] = readVLQ(b, p, end);
          need(mlen);
          const data = b.slice(p, p + mlen);
          p += mlen;
          if (type === 0x2f) {
            endTick = tick;
            break;
          }
          events.push({ tick, kind: 'meta', type, data });
        } else if (status === 0xf0 || status === 0xf7) {
          let slen;
          [slen, p] = readVLQ(b, p, end);
          need(slen);
          events.push({ tick, kind: 'sysex', status, data: b.slice(p, p + slen) });
          p += slen;
        } else if (status >= 0xf0) {
          throw new Error('SMFでは使えないステータスバイトです: 0x' + status.toString(16));
        } else {
          const hi = status & 0xf0;
          const ch = status & 0x0f;
          const len = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
          need(len);
          const d1 = b[p++] & 0x7f;
          const d2 = len === 2 ? b[p++] & 0x7f : 0;
          events.push({ tick, kind: 'ch', status: hi, ch, d1, d2 });
        }
      }
      p = end;
      tracks.push({ events, endTick: Math.max(endTick, tick) });
    }
    return { format, ppq: division, tracks };
  }

  // 同一tick内の並び順: meta → sysex → note-off → CC等 → note-on
  function eventOrder(e) {
    if (e.kind === 'meta') return 0;
    if (e.kind === 'sysex') return 1;
    if (e.status === STATUS.NOTE_OFF || (e.status === STATUS.NOTE_ON && e.d2 === 0)) return 2;
    if (e.status === STATUS.NOTE_ON) return 4;
    return 3;
  }

  /** @returns {Uint8Array} */
  function writeMidi(midi) {
    const out = [];
    const pushStr = (s) => {
      for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    };
    const pushU32 = (v) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    const pushU16 = (v) => out.push((v >>> 8) & 0xff, v & 0xff);

    const format = midi.tracks.length > 1 ? 1 : midi.format === 1 ? 1 : 0;
    pushStr('MThd');
    pushU32(6);
    pushU16(format);
    pushU16(midi.tracks.length);
    pushU16(midi.ppq);

    for (const track of midi.tracks) {
      // 丸め後のtickで並べる（丸めでnote-onとnote-offの順序が逆転しないように）
      const events = track.events
        .map((e, i) => {
          if (!Number.isFinite(e.tick)) throw new Error('不正なイベント位置です');
          return { e, i, tick: Math.max(0, Math.round(e.tick)) };
        })
        .sort((a, b) => a.tick - b.tick || eventOrder(a.e) - eventOrder(b.e) || a.i - b.i);
      const body = [];
      let last = 0;
      for (const { e, tick } of events) {
        writeVLQ(tick - last, body);
        last = tick;
        if (e.kind === 'meta') {
          body.push(0xff, e.type);
          writeVLQ(e.data.length, body);
          for (const d of e.data) body.push(d);
        } else if (e.kind === 'sysex') {
          body.push(e.status);
          writeVLQ(e.data.length, body);
          for (const d of e.data) body.push(d);
        } else {
          body.push(e.status | e.ch, e.d1 & 0x7f);
          if (e.status !== 0xc0 && e.status !== 0xd0) body.push(e.d2 & 0x7f);
        }
      }
      const endTick = Math.max(last, Math.round(track.endTick || 0));
      writeVLQ(endTick - last, body);
      body.push(0xff, 0x2f, 0x00);
      pushStr('MTrk');
      pushU32(body.length);
      for (const d of body) out.push(d);
    }
    return new Uint8Array(out);
  }

  /** note-on/off を対にしてノート配列にする（同一音高はFIFOで対応付け） */
  function extractNotes(midi) {
    const notes = [];
    midi.tracks.forEach((track, ti) => {
      const open = new Map();
      for (const e of track.events) {
        if (e.kind !== 'ch') continue;
        const key = e.ch * 128 + e.d1;
        if (e.status === STATUS.NOTE_ON && e.d2 > 0) {
          if (!open.has(key)) open.set(key, []);
          open.get(key).push(e);
        } else if (e.status === STATUS.NOTE_OFF || (e.status === STATUS.NOTE_ON && e.d2 === 0)) {
          const q = open.get(key);
          if (!q || !q.length) continue;
          const on = q.shift();
          notes.push({ track: ti, ch: e.ch, pitch: e.d1, vel: on.d2, offVel: e.status === STATUS.NOTE_OFF ? e.d2 : 64, tick: on.tick, endTick: e.tick });
        }
      }
      for (const q of open.values()) {
        for (const on of q) notes.push({ track: ti, ch: on.ch, pitch: on.d1, vel: on.d2, offVel: 64, tick: on.tick, endTick: Math.max(on.tick + 1, track.endTick) });
      }
    });
    notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    notes.forEach((n, i) => {
      n.id = i;
      n.srcVel = n.vel;
    });
    return notes;
  }

  /**
   * 元MIDIのノート以外のイベントを残し、ノートとCC・ピッチベンドを差し替えた新しいMIDIを作る。
   * @param {Set<number|'pb'>} replaceCC 既存イベントを削除するCC番号（'pb' ならピッチベンド）
   * @param {Set<number>} replaceChannels 上記の削除を行うチャンネル
   * @param {{tick:number, value:number, track:number, ch:number}[]} [pbs] 書き込むピッチベンド（値は -8192〜8191）
   */
  function rebuildMidi(src, notes, ccs, replaceCC, replaceChannels, pbs = []) {
    const tracks = src.tracks.map((t) => ({
      endTick: t.endTick,
      events: t.events.filter((e) => {
        if (e.kind !== 'ch') return true;
        if (e.status === STATUS.NOTE_ON || e.status === STATUS.NOTE_OFF) return false;
        if (e.status === STATUS.CC && replaceCC.has(e.d1) && replaceChannels.has(e.ch)) return false;
        if (e.status === STATUS.PB && replaceCC.has('pb') && replaceChannels.has(e.ch)) return false;
        return true;
      }),
    }));
    for (const n of notes) {
      const t = tracks[n.track];
      t.events.push({ tick: n.tick, kind: 'ch', status: STATUS.NOTE_ON, ch: n.ch, d1: n.pitch, d2: n.vel });
      t.events.push({ tick: n.endTick, kind: 'ch', status: STATUS.NOTE_OFF, ch: n.ch, d1: n.pitch, d2: n.offVel == null ? 64 : n.offVel });
      t.endTick = Math.max(t.endTick, n.endTick);
    }
    for (const c of ccs) {
      const t = tracks[c.track];
      t.events.push({ tick: c.tick, kind: 'ch', status: STATUS.CC, ch: c.ch, d1: c.cc, d2: c.value });
      t.endTick = Math.max(t.endTick, c.tick);
    }
    for (const b of pbs) {
      const t = tracks[b.track];
      const v = b.value + 8192;
      t.events.push({ tick: b.tick, kind: 'ch', status: STATUS.PB, ch: b.ch, d1: v & 0x7f, d2: v >> 7 });
      t.endTick = Math.max(t.endTick, b.tick);
    }
    return { format: src.format, ppq: src.ppq, tracks };
  }

  const isNoteEvent = (e) => e.kind === 'ch' && (e.status === STATUS.NOTE_ON || e.status === STATUS.NOTE_OFF);
  const partKeyOf = (track, ch) => track + ':' + ch;

  /**
   * ノートを含むトラック・チャンネルの一覧（ノート数の多い順）。
   * @returns {{key:string, track:number, ch:number, notes:number, name:string}[]}
   */
  function listParts(midi) {
    const parts = new Map();
    const decoder = new TextDecoder();
    midi.tracks.forEach((t, ti) => {
      const nameEv = t.events.find((e) => e.kind === 'meta' && e.type === 0x03);
      const name = nameEv ? decoder.decode(nameEv.data).trim() : '';
      for (const e of t.events) {
        if (!isNoteEvent(e) || e.status !== STATUS.NOTE_ON || e.d2 === 0) continue;
        const key = partKeyOf(ti, e.ch);
        if (!parts.has(key)) parts.set(key, { key, track: ti, ch: e.ch, notes: 0, name });
        parts.get(key).notes++;
      }
    });
    return [...parts.values()].sort((a, b) => b.notes - a.notes || a.track - b.track || a.ch - b.ch);
  }

  /**
   * 指定パート以外のチャンネルイベントを取り除いたMIDIと、取り除いたイベント（トラック別）を返す。
   * 取り除くのは他パートのノートと、他パートと同じトラック・チャンネルにあるCC等（加工で消さないため）。
   * ノートの無いトラックのCC等は残す。part が null なら全ノートを対象とする。配列なら複数パートをまとめて対象にする。
   * @param {string|string[]|null} part
   */
  function splitPart(midi, part) {
    const others = midi.tracks.map(() => []);
    if (part == null) return { midi, others };
    const targets = new Set(Array.isArray(part) ? part : [part]);
    const otherParts = new Set(listParts(midi).map((p) => p.key).filter((k) => !targets.has(k)));
    const tracks = midi.tracks.map((t, ti) => ({
      endTick: t.endTick,
      events: t.events.filter((e) => {
        if (e.kind !== 'ch' || !otherParts.has(partKeyOf(ti, e.ch))) return true;
        others[ti].push(e);
        return false;
      }),
    }));
    return { midi: { format: midi.format, ppq: midi.ppq, tracks }, others };
  }

  /** splitPart で取り除いたイベントを、加工後のMIDIに戻す */
  function mergeOthers(midi, others) {
    if (!others.some((list) => list.length)) return midi;
    const tracks = midi.tracks.map((t, ti) => ({ endTick: t.endTick, events: t.events.concat(others[ti] || []) }));
    return { format: midi.format, ppq: midi.ppq, tracks };
  }

  /**
   * 指定パートだけを残したMIDI（書き出しの「加工対象のトラックのみ」）。
   * 残すトラック: 先頭のトラック（テンポ・拍子などを持つ）、指定パートのノートを含むトラック、
   * ノートが無く指定パートのチャンネルのイベント（音色・CC等）を持つトラック。
   * 残したトラックからも、他パートのチャンネルイベントは取り除く。トラックが1つ（フォーマット0）なら他パートのイベントを除くだけ
   * @param {string|string[]} part 'トラック:チャンネル'（配列なら複数）
   */
  function extractParts(midi, part) {
    const targets = new Set(Array.isArray(part) ? part : [part]);
    const channels = new Set([...targets].map((k) => Number(k.split(':')[1])));
    const split = splitPart(midi, part).midi;
    const keep = midi.tracks.map((t, ti) => {
      if (ti === 0) return true;
      const notes = t.events.filter(isNoteEvent);
      if (notes.some((e) => targets.has(partKeyOf(ti, e.ch)))) return true;
      return !notes.length && t.events.some((e) => e.kind === 'ch' && channels.has(e.ch));
    });
    return { format: split.tracks.length > 1 ? split.format : 0, ppq: split.ppq, tracks: split.tracks.filter((_, ti) => keep[ti]) };
  }

  /**
   * ノートを含むトラック（extractParts の後なら加工対象のトラック）を、最初のそのトラックの位置にまとめる（ピアノの書き出し）。
   * 2トラックに分けるときは右手・左手のトラックにし、ノート以外のチャンネルイベント（ペダル等）は両方に書く。チャンネルは元のまま。
   * まとめた先頭のトラックのメタイベント（テンポ・トラック名等）は右手（分けないならまとめたトラック）に残し、他のトラックのメタイベントは捨てる
   * @param {object} midi extractParts の結果
   * @param {boolean} split 右手・左手の2トラックに分けるか
   * @param {(e:object)=>'R'|'L'|undefined} [handOf] note-on イベント → 手（分からなければ右手）
   */
  function groupHandTracks(midi, split, handOf) {
    const idx = midi.tracks.map((_, ti) => ti).filter((ti) => midi.tracks[ti].events.some(isNoteEvent));
    if (!idx.length || (!split && idx.length === 1)) return midi;
    const base = midi.tracks[idx[0]];
    const endTick = Math.max(...idx.map((ti) => midi.tracks[ti].endTick));
    const metas = base.events.filter((e) => e.kind !== 'ch');
    const chEvents = idx.flatMap((ti) => midi.tracks[ti].events.filter((e) => e.kind === 'ch'));
    let grouped;
    if (!split) grouped = [{ endTick, events: metas.concat(chEvents) }];
    else {
      const R = [];
      const L = [];
      const active = new Map(); // チャンネル:音高 → 鳴っている音の手（古い順）
      // 書き出しと同じ順（同じ位置では note-off が先）で、note-off を対応する note-on の手に振り分ける
      const sorted = chEvents.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || eventOrder(a.e) - eventOrder(b.e) || a.i - b.i);
      for (const { e } of sorted) {
        if (!isNoteEvent(e)) {
          R.push(e);
          L.push(Object.assign({}, e));
          continue;
        }
        const key = e.ch + ':' + e.d1;
        if (!active.has(key)) active.set(key, []);
        let hand;
        if (e.status === STATUS.NOTE_ON && e.d2 > 0) {
          hand = (handOf && handOf(e)) === 'L' ? 'L' : 'R';
          active.get(key).push(hand);
        } else hand = active.get(key).shift() || 'R';
        (hand === 'L' ? L : R).push(e);
      }
      const nameEv = metas.find((e) => e.kind === 'meta' && e.type === 0x03);
      const name = (nameEv && new TextDecoder().decode(nameEv.data).trim()) || 'Piano';
      const title = (text) => ({ tick: 0, kind: 'meta', type: 0x03, data: new TextEncoder().encode(name + ' ' + text) });
      grouped = [
        { endTick, events: [title('RH')].concat(metas.filter((e) => e !== nameEv), R) },
        { endTick, events: [title('LH')].concat(L) },
      ];
    }
    const tracks = [];
    midi.tracks.forEach((t, ti) => {
      if (ti === idx[0]) tracks.push(...grouped);
      else if (!idx.includes(ti)) tracks.push(t);
    });
    return { format: tracks.length > 1 ? 1 : 0, ppq: midi.ppq, tracks };
  }

  MH.STATUS = STATUS;
  MH.groupHandTracks = groupHandTracks;
  MH.listParts = listParts;
  MH.splitPart = splitPart;
  MH.extractParts = extractParts;
  MH.mergeOthers = mergeOthers;
  MH.parseMidi = parseMidi;
  MH.writeMidi = writeMidi;
  MH.extractNotes = extractNotes;
  MH.rebuildMidi = rebuildMidi;
})(typeof window !== 'undefined' ? window : globalThis);
