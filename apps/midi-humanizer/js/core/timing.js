/**
 * テンポマップ・拍子マップ。tick ⇔ ms 変換と、小節内の拍位置の算出を行う。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  function buildTimeMaps(midi) {
    const ppq = midi.ppq;
    const tempos = [];
    const sigs = [];
    for (const t of midi.tracks) {
      for (const e of t.events) {
        if (e.kind !== 'meta') continue;
        if (e.type === 0x51 && e.data.length >= 3) {
          const us = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
          if (us > 0) tempos.push({ tick: e.tick, us });
        }
        // 分母は 2^0〜2^6（1〜64分音符）のみ有効とする
        if (e.type === 0x58 && e.data.length >= 2 && e.data[0] >= 1 && e.data[1] <= 6) sigs.push({ tick: e.tick, num: e.data[0], den: Math.pow(2, e.data[1]) });
      }
    }
    const normalize = (list, def) => {
      list.sort((a, b) => a.tick - b.tick);
      const out = [];
      for (const x of list) {
        if (out.length && out[out.length - 1].tick === x.tick) out[out.length - 1] = x;
        else out.push(x);
      }
      if (!out.length || out[0].tick > 0) out.unshift(Object.assign({ tick: 0 }, def));
      return out;
    };
    const tempoList = normalize(tempos, { us: 500000 });
    const sigList = normalize(sigs, { num: 4, den: 4 });

    let ms = 0;
    tempoList.forEach((t, i) => {
      if (i > 0) {
        const prev = tempoList[i - 1];
        ms += ((t.tick - prev.tick) / ppq) * (prev.us / 1000);
      }
      t.ms = ms;
    });

    let barIndex = 0;
    sigList.forEach((s, i) => {
      s.barTicks = (s.num * ppq * 4) / s.den;
      s.compound = isCompound(s.num, s.den);
      s.pulseTicks = s.compound ? (3 * ppq * 4) / s.den : (ppq * 4) / s.den;
      s.pulses = meterPulses(s.num, s.den);
      if (i > 0) {
        const prev = sigList[i - 1];
        barIndex += Math.ceil((s.tick - prev.tick) / prev.barTicks);
      }
      s.barIndex = barIndex;
    });

    // list[key] が value 以下となる最後の要素（二分探索）
    const findLast = (list, value, key = 'tick') => {
      let lo = 0;
      let hi = list.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (list[mid][key] <= value) lo = mid;
        else hi = mid - 1;
      }
      return list[lo];
    };

    function usAt(tick) {
      return findLast(tempoList, tick).us;
    }
    function tickToMs(tick) {
      const t = findLast(tempoList, tick);
      return t.ms + ((tick - t.tick) / ppq) * (t.us / 1000);
    }
    function msToTick(ms) {
      const t = findLast(tempoList, ms, 'ms');
      return t.tick + ((ms - t.ms) * 1000 * ppq) / t.us;
    }
    /** tick位置から ms だけずらしたときの tick 差（符号付き。テンポ変更をまたいでも正確） */
    function msToTicks(tick, ms) {
      return msToTick(tickToMs(tick) + ms) - tick;
    }

    /**
     * level: 0=小節頭, 1=拍頭, 2=拍の半分（4/4なら8分裏）, 3=さらに半分（16分）, 4=それ以下, 5=グリッド外
     */
    function position(tick) {
      const s = findLast(sigList, tick);
      const rel = tick - s.tick;
      const barInSeg = Math.floor(rel / s.barTicks);
      const posInBar = rel - barInSeg * s.barTicks;
      const beat = Math.floor(posInBar / s.pulseTicks + 1e-9);
      const posInBeat = posInBar - beat * s.pulseTicks;
      let level;
      if (Math.abs(posInBar) < 1) level = 0;
      else if (Math.abs(posInBeat) < 1) level = 1;
      else {
        const divs = s.compound ? [3, 6, 12] : [2, 4, 8];
        level = 5;
        for (let i = 0; i < divs.length; i++) {
          const unit = s.pulseTicks / divs[i];
          if (Math.abs(posInBeat - Math.round(posInBeat / unit) * unit) <= 1) {
            level = 2 + i;
            break;
          }
        }
      }
      return {
        bar: s.barIndex + barInSeg,
        barStartTick: s.tick + barInSeg * s.barTicks,
        posInBar,
        barTicks: s.barTicks,
        beat,
        beatFrac: posInBeat / s.pulseTicks,
        pulseTicks: s.pulseTicks,
        pulses: s.pulses,
        compound: s.compound,
        meter: `${s.num}/${s.den}`,
        level,
      };
    }

    return { ppq, tempos: tempoList, sigs: sigList, usAt, tickToMs, msToTick, msToTicks, position };
  }

  // 6/8・9/8・12/8 などの複合拍子は付点4分を1拍として扱う
  function isCompound(num, den) {
    return den >= 8 && num % 3 === 0 && num > 3;
  }
  /** 1小節の拍数（複合拍子は付点4分を1拍。6/8 → 2） */
  function meterPulses(num, den) {
    return isCompound(num, den) ? num / 3 : num;
  }

  /** 曲の拍子（"3/4" など）。途中で変わるときは、endTick までで最も長く続く拍子 */
  function dominantMeter(maps, endTick) {
    const len = new Map();
    maps.sigs.forEach((s, i) => {
      const next = maps.sigs[i + 1];
      const key = `${s.num}/${s.den}`;
      len.set(key, (len.get(key) || 0) + Math.max(0, Math.min(next ? next.tick : endTick, endTick) - s.tick));
    });
    let best = `${maps.sigs[0].num}/${maps.sigs[0].den}`;
    for (const [key, v] of len) if (v > (len.get(best) || 0)) best = key;
    return best;
  }

  /**
   * 拍子の変わる位置（小節頭の tick。曲頭は含まない。同じ拍子の指定し直しは除く）
   * @param {number} [endTick] これより前の位置だけ（後ろにノートの無い区間を作らないため）
   */
  function meterChanges(maps, endTick = Infinity) {
    const out = [];
    maps.sigs.forEach((s, i) => {
      const prev = maps.sigs[i - 1];
      if (prev && s.tick < endTick && (s.num !== prev.num || s.den !== prev.den)) out.push(s.tick);
    });
    return out;
  }

  MH.buildTimeMaps = buildTimeMaps;
  MH.dominantMeter = dominantMeter;
  MH.meterChanges = meterChanges;
  MH.meterPulses = meterPulses;
})(typeof window !== 'undefined' ? window : globalThis);
