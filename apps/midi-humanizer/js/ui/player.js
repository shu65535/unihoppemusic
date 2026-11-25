/**
 * 試聴（Web Audio）。サウンドフォントの音色（js/ui/sf2.js）を読み込めたチャンネルはその音色で、
 * それ以外は確認用の簡易シンセ（ベロシティ・タイミング・ペダルの差を聴き比べる用途）で鳴らす。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  let ac = null;
  let master = null;
  let noiseBuf = null;
  let active = [];
  const MASTER_GAIN = 0.5; // 音量 0 dB のときのゲイン
  const VOLUME_MIN_DB = -60; // これ以下は無音（-∞）
  const CEILING_DB = -1; // リミッターの上限（これを超える音は出さない）
  let volumeDb = 0; // 試聴の音量（dB）
  const volumeGain = () => (volumeDb <= VOLUME_MIN_DB ? 0 : MASTER_GAIN * 10 ** (volumeDb / 20));

  /** 試聴の音量（dB。VOLUME_MIN_DB 以下は無音）を変える。再生中でもすぐ反映する */
  function setVolume(db) {
    volumeDb = Math.min(12, Number(db) || 0);
    if (master) master.gain.setTargetAtTime(volumeGain(), ac.currentTime, 0.02); // 急な変化でノイズが出ないよう少し滑らかに
  }

  /**
   * 出力の手前のリミッター（CEILING_DB を超えないように抑える）。input → 戻り値 の順につなぐ。
   * コンプレッサーで滑らかに抑え、抑えきれない立ち上がりの一瞬だけ上限で切る（音割れ防止の安全策）
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} input
   * @returns {AudioNode}
   */
  function connectLimiter(ctx, input) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = CEILING_DB - 2; // 比 20 でも漏れる分を見込み、少し下から抑える
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0;
    comp.release.value = 0.1;
    // コンプレッサーは自動で音を持ち上げる（仕様の makeup gain）ため、その分を戻す
    const t = comp.threshold.value;
    const makeupDb = 0.6 * -(t + -t / comp.ratio.value);
    const trim = ctx.createGain();
    trim.gain.value = 10 ** (-makeupDb / 20);
    const ceiling = 10 ** (CEILING_DB / 20);
    const clip = ctx.createWaveShaper();
    const n = 4097;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.max(-ceiling, Math.min(ceiling, (i / (n - 1)) * 2 - 1)); // ±1 を超える入力は端の値（±上限）になる
    clip.curve = curve;
    input.connect(comp).connect(trim).connect(clip);
    return clip;
  }

  function ensureCtx() {
    if (!ac) {
      // 音を作る作業領域（バッファ）を大きめにして、負荷が一瞬上がっても途切れにくくする（DAW のバッファサイズと同じ。遅れは position で補う）
      ac = new (root.AudioContext || root.webkitAudioContext)({ latencyHint: 'playback' });
      master = ac.createGain();
      master.gain.value = volumeGain();
      connectLimiter(ac, master).connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  const hz = (p) => 440 * Math.pow(2, (p - 69) / 12);
  const amp = (v) => Math.pow(v / 127, 2) * 0.35;

  function track(node) {
    active.push(node);
    // 鳴り終わった音は手放す（ループで予約し続けても増え続けないように）
    node.onended = () => {
      const i = active.indexOf(node);
      if (i >= 0) active.splice(i, 1);
      node.disconnect(); // つながった先（フィルター・音量など）も音の処理から外れるように
    };
    return node;
  }

  function tone(t0, dur, pitch, vel, kind) {
    const osc = track(ac.createOscillator());
    const flt = ac.createBiquadFilter();
    const g = ac.createGain();
    osc.type = kind === 'guitar' ? 'sawtooth' : 'triangle';
    osc.frequency.value = hz(pitch);
    flt.type = 'lowpass';
    flt.frequency.value = kind === 'guitar' ? 1200 + vel * 20 : 2500 + vel * 30;
    const a = amp(vel);
    const decay = kind === 'guitar' ? 1.2 : 2.5;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(a, t0 + 0.004);
    g.gain.setTargetAtTime(a * 0.25, t0 + 0.004, decay / 3);
    g.gain.setTargetAtTime(0, t0 + dur, 0.06);
    osc.connect(flt).connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.5);
  }

  function noise(t0, len, vel, type, freq, q) {
    const src = track(ac.createBufferSource());
    src.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q || 1;
    const g = ac.createGain();
    g.gain.setValueAtTime(amp(vel) * 1.2, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + len + 0.05);
  }

  function thump(t0, vel, f0, f1, len) {
    const osc = track(ac.createOscillator());
    const g = ac.createGain();
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + len * 0.6);
    g.gain.setValueAtTime(amp(vel) * 2, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + len + 0.05);
  }

  function drum(t0, pitch, vel, detail) {
    const part = MH.drumPartType(detail);
    if (part === 'kick') thump(t0, vel, 140, 45, 0.35);
    else if (part === 'snare' || part === 'rim') {
      noise(t0, 0.18, vel, 'bandpass', 1800, 0.8);
      thump(t0, vel * 0.6, 220, 160, 0.1);
    } else if (part === 'hat') noise(t0, detail === 'hatOpen' ? 0.35 : 0.05, vel * 0.7, 'highpass', 7000);
    else if (part === 'tom') {
      // GM配列のタム（41〜50）を基準に音程を決める。他の配列でも極端な音程にならないよう範囲を制限
      const step = Math.max(0, Math.min(9, pitch - 41));
      thump(t0, vel, 60 + step * 15, 40 + step * 10, 0.3);
    }
    else if (part === 'crash' || part === 'ride') noise(t0, part === 'crash' ? 1.4 : 0.5, vel * 0.6, 'highpass', 5000);
    else noise(t0, 0.08, vel * 0.6, 'bandpass', 5000, 2);
  }

  /** CC64から「ペダルが上がる時刻」を求め、踏んでいる間に離した音を延長する */
  function pedalEnd(ccs, tick, endTick) {
    let down = false;
    let lastUpAfter = null;
    for (const c of ccs) {
      if (c.cc !== 64) continue;
      if (c.tick <= endTick) down = c.value >= 64;
      else if (down && c.value < 64) {
        lastUpAfter = c.tick;
        break;
      }
    }
    return down ? (lastUpAfter == null ? endTick : lastUpAfter) : endTick;
  }

  /**
   * @param {object} [drumMap] ドラムの音の高さ→パーツの対応（省略時はGM配列）
   * @param {number} [startTick] 再生を始める位置。その時点で鳴っている音（ドラム以外）は途中から鳴らす
   * @param {{start:number, end:number}} [loop] ループする区間。再生位置が区間の終わりより前なら、終わりで区間の頭に戻ってくり返す
   * @param {Object<number,string>} [programs] チャンネル → サウンドフォントの音色のキー（MH.sf2.programsOf）。読み込めていない音色は簡易シンセで鳴らす
   */
  function play(notes, ccs, maps, instrument, drumMap, startTick, loop, programs) {
    stop();
    ensureCtx();
    session = {};
    schedule(notes, ccs, maps, instrument, drumMap, Math.max(0, startTick || 0), loop, ac.currentTime + 0.1, programs);
    setPlaying(true);
  }

  /**
   * from から鳴らす音を予約する。ループで区間の頭に戻るときは、再生中のまま次の周回を予約する
   * @param {number} t0 from を鳴らす時刻（AudioContext の時刻）
   */
  function schedule(notes, ccs, maps, instrument, drumMap, from, loop, t0, programs) {
    const partOf = MH.drumPartResolver(drumMap);
    const soundPitch = instrument === 'drums' ? MH.drumSoundPitch(drumMap) : (p) => p; // サウンドフォント（GM配列）で鳴らす音の高さ
    const loopEnd = loop && loop.end > loop.start && from < loop.end ? loop.end : null;
    const fromSec = maps.tickToMs(from) / 1000;
    const sec = (tick) => maps.tickToMs(tick) / 1000 - fromSec;
    const pedal = ccs.filter((c) => c.cc === 64);
    const targets = notes
      .map((n) => ({ n, end: instrument === 'piano' ? pedalEnd(pedal, n.tick, n.endTick) : n.endTick }))
      // 正規化で寄せ切らなかった音は tick が小数になるため、開始位置ちょうどの音を落とさないよう幅を持たせる
      .filter(({ n, end }) => (instrument === 'drums' ? n.tick >= from - 0.5 : end > from))
      // ループするときは区間の終わりまで（伸びている音も終わりで止める）
      .filter(({ n }) => loopEnd == null || n.tick < loopEnd)
      .map(({ n, end }) => ({ n, end: loopEnd == null ? end : Math.min(end, loopEnd) }))
      .sort((a, b) => a.n.tick - b.n.tick);
    let last = 0;
    const sfKey = (ch) => (programs && programs[ch] && MH.sf2 && MH.sf2.loaded(programs[ch]) ? programs[ch] : null);
    const playNote = ({ n, end }, start, s) => {
      const key = sfKey(n.ch);
      if (key) {
        // 鳴っている途中から始めるときは、サンプルもその位置から鳴らす
        const v = MH.sf2.voice(ac, master, key, soundPitch(n.pitch), n.vel, s, Math.max(0.02, sec(end) - sec(start)), sec(start) - sec(n.tick), instrument === 'drums');
        v.sources.forEach(track);
        if (v.ex) {
          const ex = n.ch + ':' + v.ex;
          const prev = exclusive.get(ex);
          if (prev && prev.end > s) MH.sf2.choke(prev, s);
          exclusive.set(ex, v);
        }
        last = Math.max(last, v.end - t0);
      } else if (instrument === 'drums') drum(s, n.pitch, n.vel, partOf(n.pitch));
      else tone(s, Math.max(0.02, sec(end) - sec(start)), n.pitch, n.vel, instrument);
      last = Math.max(last, sec(end));
    };
    // 少し先（LOOKAHEAD 秒）までに鳴る音だけを少しずつ予約する（DAW と同じ）。
    // 一度に全部予約すると、まだ鳴らない音の分まで音を作る処理が重くなり、音が途切れる
    const token = session;
    let i = 0;
    const pump = () => {
      if (token !== session) return; // 停止・再生し直し
      const horizon = ac.currentTime + LOOKAHEAD;
      for (; i < targets.length; i++) {
        const start = Math.max(targets[i].n.tick, from);
        const s = t0 + sec(start);
        if (s >= horizon) break;
        playNote(targets[i], start, s);
      }
      if (i < targets.length) setTimeout(pump, PUMP_MS);
      else if (loopEnd == null) endTimer = setTimeout(stop, (t0 - ac.currentTime + last + 0.7) * 1000); // 鳴り終わり（余韻を含む）で停止扱いにする
    };
    pump();
    // 先の周回を予約した時点では、まだ今の周回の位置を返す
    clock = { t0, fromMs: fromSec * 1000, maps, prev: clock && ac.currentTime < t0 ? clock : null };
    if (clock.prev) clock.prev.prev = null;
    if (loopEnd != null) {
      // 区間の終わりの少し前に、次の周回（区間の頭から）を予約する。周回の間で時刻がずれないよう、終わりの時刻ちょうどに続ける
      const lapSec = (maps.tickToMs(loopEnd) - maps.tickToMs(loop.start)) / 1000;
      const lead = Math.min(LOOP_LEAD, lapSec / 2); // 短い区間でも1回の予約で1周回だけ進むように
      const next = t0 + sec(loopEnd);
      endTimer = setTimeout(() => {
        // タイマーが遅れた（裏のタブ・重い処理）ときは、過ぎた周回を飛ばして次の周回の頭から鳴らす
        let at = next;
        while (at < ac.currentTime + 0.05) at += lapSec;
        schedule(notes, ccs, maps, instrument, drumMap, loop.start, loop, at, programs);
      }, Math.max(0, next - ac.currentTime - lead) * 1000);
    }
  }
  const LOOP_LEAD = 0.25; // ループの次の周回を予約する前倒しの時間（秒）
  const LOOKAHEAD = 1; // 何秒先までの音を予約しておくか（画面の操作などでタイマーが遅れても途切れない程度）
  const PUMP_MS = 100; // 予約を進める間隔（ミリ秒）

  let endTimer = null;
  let session = null; // 再生ごとの目印（停止・再生し直しで変わり、前の再生の予約を止める）
  // 同時に鳴らない音（チャンネル:番号。ハイハットの開閉など）→ 前の音。ループの周回をまたいで止められるよう、停止まで持つ
  const exclusive = new Map();
  let playing = false;
  let listener = null;
  let clock = null; // 再生位置の計算用

  /** 再生中の位置（tick）。停止中は null */
  function position() {
    if (!playing || !clock) return null;
    // 今スピーカーから出ている音の時刻（バッファの分だけ ac.currentTime より遅れる）
    const now = ac.currentTime - (ac.outputLatency || ac.baseLatency || 0);
    // 次の周回を前倒しで予約した後、その周回が始まるまでは前の周回の位置
    const c = now < clock.t0 && clock.prev ? clock.prev : clock;
    return c.maps.msToTick(c.fromMs + Math.max(0, now - c.t0) * 1000);
  }
  function setPlaying(v) {
    if (playing === v) return;
    playing = v;
    if (listener) listener(v);
  }

  function stop() {
    clearTimeout(endTimer);
    session = null;
    for (const n of active) {
      try {
        n.stop();
      } catch (e) {
        /* 既に停止済み */
      }
    }
    active = [];
    exclusive.clear();
    clock = null;
    setPlaying(false);
  }

  MH.player = {
    play,
    stop,
    isPlaying: () => playing,
    position,
    setVolume,
    connectLimiter,
    VOLUME_MIN_DB,
    /** 再生状態が変わったときに呼ぶ関数（引数: 再生中か）を設定する */
    onStateChange: (fn) => (listener = fn),
  };
})(typeof window !== 'undefined' ? window : globalThis);
