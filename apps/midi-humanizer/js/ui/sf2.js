/**
 * サウンドフォントの音色（tools/build-sf2.js で src/sf2/_built/ に変換したもの）を読み込み、試聴の発音に使う。
 * file:// で開くため、音色ファイルは <script> を差し込んで読み込む（使う音色だけ）。
 * 一覧（MH.SF2_INDEX）が無ければ（変換していなければ）使えないので、試聴は簡易シンセで鳴らす。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const BASE = 'sf2/_built/';
  const presets = new Map(); // キー（'バンク:番号'）→ 読み込んだ音色
  const loading = new Map(); // キー → 読み込み中の Promise
  const failed = new Set(); // 読み込めなかったキー（簡易シンセで鳴らす）
  const DEFAULT = { piano: '0:0', guitar: '0:25', drums: '128:0' }; // 楽器ごとの既定（GM）

  const index = () => MH.SF2_INDEX || {};
  const available = () => Object.keys(index()).length > 0;

  /** 音色ファイルから呼ばれる */
  function register(key, data) {
    data.buffers = [];
    presets.set(key, data);
  }

  function load(key) {
    if (presets.has(key)) return Promise.resolve(presets.get(key));
    if (loading.has(key)) return loading.get(key);
    const entry = index()[key];
    if (!entry) return Promise.reject(new Error('音色がありません: ' + key));
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + entry.file;
      s.onload = () => (presets.has(key) ? resolve(presets.get(key)) : reject(new Error('音色を読み込めませんでした: ' + key)));
      s.onerror = () => reject(new Error('音色ファイルを読み込めませんでした: ' + entry.file));
      document.head.appendChild(s);
    })
      .catch((e) => {
        failed.add(key);
        throw e;
      })
      .finally(() => loading.delete(key));
    loading.set(key, p);
    return p;
  }

  /** 使う音色をまとめて読み込む（読み込めなかった音色は無視し、簡易シンセで鳴らす） */
  function ensure(keys) {
    return Promise.all([...new Set(keys)].map((k) => load(k).catch(() => null)));
  }
  /** 鳴らす準備ができたか（読み込めなかった音色・一覧に無い音色は簡易シンセで鳴らすので準備済みとみなす） */
  const ready = (keys) => keys.every((k) => presets.has(k) || failed.has(k) || !index()[k]);
  const loaded = (key) => presets.has(key);

  /**
   * 鳴らす音色のキーを選ぶ。ピアノ・ギターはファイルの音色指定によらず楽器ごとの音色。
   * ドラムはプログラム番号のキット（変換していなければスタンダードのキット）
   */
  function resolve(instrument, prog) {
    const idx = index();
    const k = instrument === 'drums' ? '128:' + (prog || 0) : DEFAULT[instrument];
    return idx[k] ? k : idx[DEFAULT[instrument]] ? DEFAULT[instrument] : null;
  }

  /**
   * MIDIのチャンネルごとの音色のキー（ch → キー）。ドラムのキットは各チャンネルの最初のプログラムチェンジで選ぶ
   * @param {Iterable<number>} channels 鳴らすチャンネル
   */
  function programsOf(midi, instrument, channels) {
    const first = new Map(); // ch → プログラム番号
    const events = midi.tracks.flatMap((t) => t.events).filter((e) => e.kind === 'ch' && e.status === 0xc0).sort((a, b) => a.tick - b.tick);
    for (const e of events) if (!first.has(e.ch)) first.set(e.ch, e.d1);
    const out = {};
    for (const ch of channels) out[ch] = resolve(instrument, first.get(ch));
    return out;
  }

  /** 音高・ベロシティに当たるリージョン（ステレオのサンプルは左右の2つ） */
  function regionsFor(key, pitch, vel) {
    const p = presets.get(key);
    if (!p) return [];
    return p.regions.filter((r) => pitch >= r.lo && pitch <= r.hi && vel >= r.vlo && vel <= r.vhi);
  }

  /** サンプルの AudioBuffer（初めて使うときに 16bit のデータから作る） */
  function bufferOf(key, i) {
    const p = presets.get(key);
    if (p.buffers[i]) return p.buffers[i];
    const s = p.samples[i];
    const bin = atob(s.data);
    const n = bin.length >> 1;
    const buf = new AudioBuffer({ length: Math.max(1, n), sampleRate: Math.max(3000, Math.min(384000, s.rate)), numberOfChannels: 1 });
    const d = buf.getChannelData(0);
    for (let j = 0; j < n; j++) {
      const v = bin.charCodeAt(2 * j) | (bin.charCodeAt(2 * j + 1) << 8);
      d[j] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
    }
    s.data = null; // 変換後は文字列を手放す
    p.buffers[i] = buf;
    return buf;
  }

  /**
   * 音量の包絡（ディレイ→アタック→ホールド→ディケイ→サステイン）の、発音から t 秒後の値（0〜1）。
   * ディケイ・リリースは dB で直線に下がる（SF2 の仕様。時間は 100dB 下がるまで）
   */
  function envAt(r, t) {
    const sus = Math.pow(10, -r.sustain / 200);
    if (t < r.delay) return 0;
    t -= r.delay;
    if (t < r.attack) return t / r.attack;
    t -= r.attack;
    if (t < r.hold) return 1;
    t -= r.hold;
    const db = -100 * (t / r.decay);
    return Math.max(sus, Math.pow(10, db / 20));
  }

  /**
   * 1音を鳴らす
   * @param {AudioContext} ac
   * @param {AudioNode} out 出力先
   * @param {number} t0 発音の時刻 @param {number} dur 押さえている長さ（秒） @param {number} offset 途中から鳴らすときの経過時間（秒）
   * @param {boolean} oneShot ドラム: 離しても止めず、サンプルの終わりまで鳴らす（ループするサンプルを除く）
   * @returns {{sources:AudioBufferSourceNode[], gains:GainNode[], stops:number[], ex:number, end:number}} 鳴らした音（choke・停止の処理用。stops は各 source の停止時刻）
   */
  function voice(ac, out, key, pitch, vel, t0, dur, offset, oneShot) {
    const res = { sources: [], gains: [], stops: [], ex: 0, end: t0 };
    for (const r of regionsFor(key, pitch, vel)) {
      const buf = bufferOf(key, r.s);
      const rate = buf.sampleRate;
      const pr = Math.pow(2, ((pitch - r.root) * r.scale + r.tune) / 1200); // 再生速度（音高の比）
      const sampleEnd = Math.min(buf.length, r.end) / rate; // 終了位置のオフセットを反映した終わり（秒・サンプル上）
      const startPos = r.start / rate + offset * pr;
      // ループは 1=常に 3=離すまで。3 は離した後もループしたままリリースで消す（近似）
      const looping = (r.loop & 1) === 1 && r.loopEnd > r.loopStart;
      if (!looping && startPos >= sampleEnd) continue; // 途中から鳴らす位置がサンプルの終わりより先
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pr;
      if (looping) {
        src.loop = true;
        src.loopStart = r.loopStart / rate;
        src.loopEnd = r.loopEnd / rate;
      }
      // 音量: 減衰量（cB）とベロシティ（SF2 の既定の凹型カーブに近い2乗。ベロシティ→フィルターなどの既定のモジュレーターは使わない）。
      // 減衰量は 0.4 倍で効かせる（多くの SF2 は E-mu のハードウェアに合わせて作られており、FluidSynth なども同じ扱い）
      const peak = Math.pow(10, (-r.att * 0.4) / 200) * Math.pow(vel / 127, 2) * 0.5;
      const g = ac.createGain();
      const env = g.gain;
      // 包絡は発音から離すまでの区間を予約する（途中から鳴らすときは、その時点の値から）。時刻は発音からの経過時間
      const relT = oneShot && !looping ? Infinity : offset + Math.max(0, dur); // 離す時刻
      const at = (t) => t0 + t - offset;
      const level = (t) => peak * envAt(r, t);
      env.setValueAtTime(level(offset), t0);
      const decayEnd = r.delay + r.attack + r.hold + r.decay * Math.min(1, r.sustain / 1000); // サステインの値まで下がる時刻
      const segments = [
        [r.delay, 'set'],
        [r.delay + r.attack, 'linear'],
        [r.delay + r.attack + r.hold, 'set'],
        [decayEnd, 'exp'],
      ];
      for (const [end, kind] of segments) {
        const t = Math.min(end, relT);
        if (t > offset) {
          if (kind === 'linear') env.linearRampToValueAtTime(level(t), at(t));
          else if (kind === 'exp') env.exponentialRampToValueAtTime(Math.max(1e-5, level(t)), at(t));
          else env.setValueAtTime(level(t), at(t));
        }
        if (end >= relT) break;
      }
      let stopAt = looping ? Infinity : t0 + (sampleEnd - startPos) / pr; // ループしないときはサンプルの終わり
      if (relT !== Infinity) {
        const release = Math.max(0.01, r.release);
        env.setTargetAtTime(0, at(relT), release / 11.5); // 100dB 下がるまでが release 秒
        stopAt = Math.min(stopAt, at(relT) + release);
      }
      let node = src;
      if (r.fc < 13500) {
        const f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = Math.min(20000, 8.176 * Math.pow(2, r.fc / 1200));
        f.Q.value = r.q / 10; // SF2 は cB、Web Audio の lowpass の Q は dB
        node = node.connect(f);
      }
      const pan = ac.createStereoPanner();
      pan.pan.value = r.pan;
      node.connect(g).connect(pan).connect(out);
      // ループ区間より先から鳴らすときは、ループ区間の中に折り返す
      const loopLen = src.loopEnd - src.loopStart;
      src.start(t0, looping && startPos >= src.loopEnd ? src.loopStart + ((startPos - src.loopStart) % loopLen) : startPos);
      src.stop(stopAt + 0.05);
      res.sources.push(src);
      res.gains.push(g);
      res.stops.push(stopAt + 0.05);
      res.ex = r.ex || res.ex;
      res.end = Math.max(res.end, stopAt);
    }
    return res;
  }

  /** 同じ番号（ex）の前の音を、次の音の発音時刻で止める（ハイハットの開閉など） */
  function choke(prev, t) {
    for (const g of prev.gains) {
      // 途中のランプを消すと値が戻ってしまうので、その時点の値で止めてから下げる
      if (g.gain.cancelAndHoldAtTime) g.gain.cancelAndHoldAtTime(t);
      else g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.01);
    }
    // 予約済みの停止より遅くはしない（stop は呼び直すと後の指定で上書きされる）
    prev.sources.forEach((s, i) => s.stop(Math.min(prev.stops[i], t + 0.08)));
    prev.end = Math.min(prev.end, t + 0.08);
  }

  MH.sf2 = { available, register, load, ensure, ready, loaded, resolve, programsOf, regionsFor, voice, choke, envAt, DEFAULT };
})(typeof window !== 'undefined' ? window : globalThis);
