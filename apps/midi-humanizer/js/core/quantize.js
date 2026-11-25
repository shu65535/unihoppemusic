/**
 * クオンタイズ: テンポの揺れを追いかけながら、拍ごとに最も自然なグリッドで開始位置を揃える。
 * 前提: ファイルのテンポは一定で、演奏の揺れ（テンポの変化・前のめり等）はノートの位置にだけ入っている。
 *
 *   [1] ほぼ同時の音を1つの発音（クラスタ）にまとめる
 *   [2] 発音を順に追い、「演奏の位置 → 楽譜上の位置」の対応（ワープ）を推定する（カルマンフィルタ）
 *   [3] ワープ後の位置で、旋律の前のめり等（声部のオフセット）を除き、拍ごとのグリッドを Viterbi で選ぶ
 *   [4] 選んだ位置からワープを局所回帰で引き直し、[3] をくり返す
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  // 全音符あたりの分割数（3連符は 8t=12, 16t=24）
  const GRIDS = { 4: 4, 8: 8, '8t': 12, 16: 16, '16t': 24, 32: 32 };
  const GRID_LABEL = { 4: '4分', 8: '8分', '8t': '8分3連', 16: '16分', '16t': '16分3連', 32: '32分' };
  const AUTO_TYPES = ['4', '8', '8t', '16', '16t', '32'];
  // 拍の分割の細かさへのペナルティ（単位は「σ だけずれた音1つ分」）。同じくらい合うなら単純な解釈を選ぶ
  const PENALTY = { 4: 0, 8: 0.5, '8t': 2, 16: 1.5, '16t': 3, 32: 3 };
  const TRIPLET = new Set(['8t', '16t']);
  // 音1つごとの、置かれた位置の細かさへのペナルティ（その位置を含む最も粗いグリッドで決める）
  const POS_PENALTY = { 4: 0, 8: 0.3, '8t': 0.6, 16: 0.8, '16t': 1.2, 32: 1.5 };
  const SWITCH_PENALTY = 1.5; // 3連 ⇔ 通常の分割の切り替え（4分はどちらにも属する）
  // 想定する1音ごとの揺れ: SIGMA_MS と 1拍（4分）の SIGMA_BEAT_RATIO の大きい方（ゆっくりした曲ほど表情による揺れが大きい）
  const SIGMA_MS = 30;
  const SIGMA_BEAT_RATIO = 0.06;
  const CLUSTER_MS = 35; // 直前の音からこの時間以内なら同時発音
  const CLUSTER_MAX_MS = 80; // クラスタ先頭からの上限（ロールした和音まで）
  const RATE_MIN = 1 / 1.5; // テンポ比の範囲（倍・半分のテンポと取り違えない）
  const RATE_MAX = 1.5;
  const ITERATIONS = 3;
  // テンポ追跡（カルマンフィルタ）: 速さの比が1拍で変わりうる大きさ（追従1のとき）、位置の揺らぎの積み重なり、ファイルのテンポへ戻る速さ
  const RATE_DRIFT_PER_BEAT = 0.05;
  const POS_DRIFT_MS = 10;
  const RATE_RETURN_BEATS = 32;
  // 休符明けの再同期: この拍数以上空いたら、続く RESYNC_LOOKAHEAD 個の発音を最もうまく説明する位置とテンポを選び直す
  const RESYNC_GAP_BEATS = 2;
  const RESYNC_LOOKAHEAD = 8;
  const AMBIGUOUS = 0.35; // グリッド幅に対するずれがこれを超えたら「判断が微妙」
  const OFF_GRID = 0.25; // グリッド幅に対するずれがこれを超えたら「グリッドから離れた音」（3連なしで揃えた3連の音は 1/3 ずれる）
  // 声部のオフセット（旋律が伴奏より全体的に前後へずれている量）の探索範囲と、ずれを認める度合い
  const OFFSET_MAX_MS = 60; // ただし16分音符の長さの OFFSET_MAX_RATIO まで（それ以上は「隣の16分から遅れた」のと区別できない）
  const OFFSET_MAX_RATIO = 0.45;
  const OFFSET_STEP_MS = 5;
  const OFFSET_PRIOR_MS = 20;
  const LEAD_SIGMA_MS = 10; // 伴奏と同時に弾いた旋律の先行量（直接測れる）をどれだけ信じるか
  const METRIC_WEIGHT = [1, 0.8, 0.5, 0.3, 0.3, 0.3]; // 小節頭・拍頭ほどテンポの基準として信頼する
  const MELODY_WEIGHT = 0.2; // 伴奏がある曲では、旋律だけの発音はテンポの基準としてあまり信頼しない（前のめり等が多いため）

  const gridTicksOf = (ppq, key) => (ppq * 4) / GRIDS[key];
  const sigmaAt = (maps, u) => Math.max(maps.msToTicks(Math.max(0, u), SIGMA_MS), SIGMA_BEAT_RATIO * maps.ppq);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  /** u を含む拍の範囲（変拍子でも小節線は越えない） */
  function beatOf(maps, u) {
    const pos = maps.position(Math.max(0, u));
    const start = pos.barStartTick + pos.beat * pos.pulseTicks;
    return { start, end: Math.min(start + pos.pulseTicks, pos.barStartTick + pos.barTicks) };
  }

  /** 拍頭を基準に、間隔 g のグリッドと拍末（次の拍頭）のうち最寄りの位置 */
  function snapInBeat(beat, u, g) {
    const q = Math.min(beat.start + Math.max(0, Math.round((u - beat.start) / g)) * g, beat.end);
    return beat.end - u < Math.abs(u - q) ? beat.end : q;
  }

  function posPenalty(maps, beat, q) {
    const rel = q - beat.start;
    if (q === beat.end || rel === 0) return 0;
    for (const key of AUTO_TYPES) {
      const x = rel / gridTicksOf(maps.ppq, key);
      if (Math.abs(x - Math.round(x)) < 1e-6) return POS_PENALTY[key];
    }
    return POS_PENALTY[32];
  }

  /** [1] 開始時刻順に並べ、直前の音から CLUSTER_MS 以内の音を同じクラスタにする。位置は最も早い音（伴奏を含む場合は quantize() で置き直す） */
  function clusterize(notes, maps) {
    const order = notes.map((n, i) => i).sort((a, b) => notes[a].tick - notes[b].tick);
    const clusters = [];
    let cur = null;
    let prevMs = 0;
    for (const i of order) {
      const ms = maps.tickToMs(notes[i].tick);
      if (cur && ms - prevMs <= CLUSTER_MS && ms - cur.ms <= CLUSTER_MAX_MS) cur.idx.push(i);
      else clusters.push((cur = { t: notes[i].tick, ms, idx: [i] }));
      prevMs = ms;
    }
    return clusters;
  }

  /** 演奏の位置 → 楽譜上の位置。クラスタ位置を節点とする折れ線（節点の外は端の傾きで延長） */
  function makeWarp(ts, ss) {
    const n = ts.length;
    const slope = (i, j) => clamp((ss[j] - ss[i]) / (ts[j] - ts[i]), RATE_MIN, RATE_MAX);
    return (t) => {
      if (!n) return t;
      if (n === 1) return ss[0] + (t - ts[0]);
      if (t <= ts[0]) return ss[0] + (t - ts[0]) * slope(0, 1);
      if (t >= ts[n - 1]) return ss[n - 1] + (t - ts[n - 1]) * slope(n - 2, n - 1);
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= t) lo = mid;
        else hi = mid;
      }
      return ss[lo] + ((t - ts[lo]) * (ss[hi] - ss[lo])) / (ts[hi] - ts[lo]);
    };
  }

  function weightOf(maps, c, q, err, sig) {
    const metric = METRIC_WEIGHT[maps.position(Math.max(0, q)).level] * (c.melody ? MELODY_WEIGHT : 1);
    // 和音は基準として信頼し、大きく外れた音（意図的な前のめり等）にはテンポを引きずられない
    return Math.min(1, metric * (1 + 0.25 * (c.idx.length - 1))) / (1 + Math.pow(err / (3 * sig), 2));
  }

  /** 拍の中で、各グリッドの最寄り位置のうちコスト最小のもの（前後の拍とのつながりは見ない仮の判断） */
  function bestInBeat(maps, types, u, sig) {
    const beat = beatOf(maps, u);
    let best = null;
    for (const key of types) {
      const q = snapInBeat(beat, u, gridTicksOf(maps.ppq, key));
      const cost = Math.pow((u - q) / sig, 2) + posPenalty(maps, beat, q) + PENALTY[key];
      if (!best || cost < best.cost) best = { q, cost };
    }
    return best;
  }

  /**
   * [2] 発音を順に追って、楽譜上の位置 s と速さの比 r（楽譜 tick / 演奏 tick）を推定する（カルマンフィルタ）。
   * 「予測の不確かさ」と「観測（グリッドとのずれ）の不確かさ」を比べて直す量を決めるので、
   * 音のまばらな曲や1音ごとの揺れには過敏に反応せず、揺れが続いたときだけテンポの変化とみなす。
   * 速さの比はファイルのテンポ（r=1）へゆるやかに戻す。
   */
  /**
   * 休符明けの再同期: 休符の間にテンポがどう変わったかは分からないため、
   * テンポ比の候補（休符前のまま / ファイルのテンポ / 中間）ごとに「そのテンポで休符を過ごした位置」の前後を探し、
   * 続く発音を最も自然に説明できる位置とテンポ比を選ぶ。
   */
  function resync(clusters, maps, types, i, pos, dt, rate) {
    const t0 = clusters[i].t;
    const range = Math.max(maps.ppq / 2, dt * 0.05);
    const step = maps.ppq / 12; // 16分と8分3連の両方の位置を含む間隔
    let best = null;
    for (const r0 of [rate, 1, (rate + 1) / 2]) {
      const center = pos + r0 * dt;
      for (let q0 = Math.ceil((center - range) / step) * step; q0 <= center + range; q0 += step) {
        if (q0 < 0) continue;
        const head = bestInBeat(maps, types, q0, sigmaAt(maps, q0));
        let cost = head.cost + Math.pow((q0 - center) / range, 2);
        for (let k = i + 1; k < Math.min(clusters.length, i + 1 + RESYNC_LOOKAHEAD); k++) {
          const uk = q0 + r0 * (clusters[k].t - t0);
          cost += bestInBeat(maps, types, uk, sigmaAt(maps, uk)).cost;
        }
        if (!best || cost < best.cost) best = { q: head.q, rate: r0, cost };
      }
    }
    return best;
  }

  function track(clusters, maps, types, follow) {
    const beat = maps.ppq;
    const qRate = Math.pow(RATE_DRIFT_PER_BEAT * follow, 2) / beat;
    const qPos = Math.pow(maps.msToTicks(0, POS_DRIFT_MS), 2) / beat;
    let t0 = clusters[0].t;
    let pos = t0;
    let rate = 1;
    let p00 = Math.pow(sigmaAt(maps, t0), 2);
    let p01 = 0;
    let p11 = Math.pow(RATE_DRIFT_PER_BEAT, 2);
    return clusters.map((c, i) => {
      const dt = c.t - t0;
      // 予測
      const tau = RATE_RETURN_BEATS * beat;
      const decay = Math.exp(-dt / tau);
      // 速さの比は区間の中でもファイルのテンポへ戻っていくので、その平均で進める（長い休符の後に位相がずれないように）
      const u = pos + (dt > 0 ? dt + ((rate - 1) * tau * (1 - decay)) : 0);
      const a00 = p00 + 2 * dt * p01 + dt * dt * p11 + qPos * dt;
      const a01 = decay * (p01 + dt * p11);
      const a11 = decay * decay * p11 + qRate * dt;
      rate = 1 + (rate - 1) * decay;
      const meas = sigmaAt(maps, u);
      if (i && dt >= RESYNC_GAP_BEATS * beat) {
        const r0 = resync(clusters, maps, types, i, pos, dt, rate);
        pos = Math.max(r0.q, pos + dt * RATE_MIN);
        rate = r0.rate;
        p00 = meas * meas;
        p01 = 0;
        p11 = Math.pow(RATE_DRIFT_PER_BEAT, 2);
        t0 = c.t;
        return pos;
      }
      // 観測: 仮に選んだグリッド位置とのずれ
      const sig = Math.sqrt(meas * meas + a00);
      const q = bestInBeat(maps, types, u, sig).q;
      const r = (meas * meas) / Math.max(1e-3, weightOf(maps, c, q, q - u, sig));
      const k0 = a00 / (a00 + r);
      const k1 = a01 / (a00 + r);
      const next = u + k0 * (q - u);
      rate = clamp(rate + k1 * (q - u), RATE_MIN, RATE_MAX);
      p00 = (1 - k0) * a00;
      p01 = (1 - k0) * a01;
      p11 = a11 - k1 * a01;
      pos = i ? Math.max(next, pos + dt * RATE_MIN) : next;
      t0 = c.t;
      return pos;
    });
  }

  /** [4] 選んだ位置とのずれを、前後の発音で重み付けした局所的な直線で当てはめ直す（片方向の追跡の遅れを消す） */
  function refit(clusters, maps, qs, warp) {
    const h = maps.ppq; // 1拍程度の範囲で平均し、1音ごとの揺れをならす
    const ts = clusters.map((c) => c.t);
    const ws = clusters.map((c, j) => {
      const sig = sigmaAt(maps, qs[j]);
      return weightOf(maps, c, qs[j], qs[j] - warp(c.t), sig);
    });
    const ss = [];
    let lo = 0;
    for (let i = 0; i < ts.length; i++) {
      while (ts[i] - ts[lo] > 3 * h) lo++;
      let sw = 0, swx = 0, swxx = 0, swd = 0, swxd = 0;
      for (let j = lo; j < ts.length && ts[j] - ts[i] <= 3 * h; j++) {
        const x = ts[j] - ts[i];
        const w = ws[j] * Math.exp(-0.5 * (x / h) * (x / h));
        const d = qs[j] - ts[j];
        sw += w;
        swx += w * x;
        swxx += w * x * x;
        swd += w * d;
        swxd += w * x * d;
      }
      // 傾き（テンポ比 − 1）はファイルのテンポ寄りに弱く引き戻す
      const ridge = 0.05 * sw * h * h;
      const det = sw * (swxx + ridge) - swx * swx;
      const b = clamp(det > 0 ? (sw * swxd - swx * swd) / det : 0, RATE_MIN - 1, RATE_MAX - 1);
      let s = ts[i] + (sw > 0 ? (swd - b * swx) / sw : 0);
      if (i) s = Math.max(s, ss[i - 1] + (ts[i] - ts[i - 1]) * RATE_MIN);
      ss.push(s);
    }
    return ss;
  }

  /**
   * 声部のオフセット: 高音側だけの発音（旋律）が、同じ小節の伴奏（低音側を含む発音）に対して全体的に前後へずれている量を小節ごとに求める。
   * 1音ずつでは「前のめりの16分」と「32分」を区別できないため、小節内の旋律をまとめて最もうまく揃うずらし量を選ぶ。
   * 伴奏と同時に弾いた旋律の先行量が測れていれば、それも手がかりにする。
   * 伴奏のない小節ではずらさない（基準がないため。全体のずれはテンポの追跡で吸収する）。
   * @returns 発音ごとの補正量（tick。楽譜上の位置 = ワープ後の位置 + 補正量）
   */
  function voiceOffsets(clusters, maps, types, us) {
    const bars = new Map();
    clusters.forEach((c, i) => {
      const bar = maps.position(Math.max(0, us[i])).bar;
      if (!bars.has(bar)) bars.set(bar, { hi: [], lo: false, leads: [] });
      const b = bars.get(bar);
      if (c.hi) b.hi.push(i);
      else b.lo = true;
      if (c.lead != null) b.leads.push(c.lead);
    });
    const off = new Array(clusters.length).fill(0);
    for (const b of bars.values()) {
      if (!b.lo || !b.hi.length) continue;
      const u0 = Math.max(0, us[b.hi[0]]);
      const max = Math.min(OFFSET_MAX_MS, (OFFSET_MAX_RATIO * (maps.ppq / 4) * SIGMA_MS) / maps.msToTicks(u0, SIGMA_MS));
      const shifts = [0];
      for (let ms = OFFSET_STEP_MS; ms <= max; ms += OFFSET_STEP_MS) shifts.push(ms, -ms);
      let best = null;
      for (const ms of shifts) {
        let cost = Math.pow(ms / OFFSET_PRIOR_MS, 2);
        for (const lead of b.leads) cost += Math.pow((ms - lead) / LEAD_SIGMA_MS, 2);
        for (const i of b.hi) {
          const u = us[i] + maps.msToTicks(Math.max(0, us[i]), ms);
          cost += bestInBeat(maps, types, u, sigmaAt(maps, u)).cost;
        }
        if (!best || cost < best.cost) best = { ms, cost };
      }
      for (const i of b.hi) off[i] = maps.msToTicks(Math.max(0, us[i]), best.ms);
    }
    return off;
  }

  /** [3] 拍ごとにグリッドを選ぶ。コスト = ずれ² ＋ 細かさのペナルティ ＋ 3連⇔通常の切り替え */
  function viterbi(clusters, maps, types, us) {
    // 声部のオフセットで拍をまたいで順序が入れ替わることがあるので、拍の開始位置で集約してから並べる
    const byBeat = new Map();
    for (let i = 0; i < us.length; i++) {
      const beat = beatOf(maps, us[i]);
      if (!byBeat.has(beat.start)) byBeat.set(beat.start, { beat, idx: [] });
      byBeat.get(beat.start).idx.push(i);
    }
    const groups = [...byBeat.values()].sort((a, b) => a.beat.start - b.beat.start);
    const family = (k) => (k === '4' ? null : TRIPLET.has(k));
    const switchCost = (a, b) => (family(a) !== null && family(b) !== null && family(a) !== family(b) ? SWITCH_PENALTY : 0);
    const local = groups.map((gr) =>
      types.map((key) => {
        const g = gridTicksOf(maps.ppq, key);
        const qs = gr.idx.map((i) => snapInBeat(gr.beat, us[i], g));
        const cost = gr.idx.reduce((a, i, k) => a + Math.pow((us[i] - qs[k]) / sigmaAt(maps, us[i]), 2) + posPenalty(maps, gr.beat, qs[k]), 0);
        return { qs, cost: cost + PENALTY[key] };
      })
    );
    let acc = local[0].map((x) => x.cost);
    const back = [];
    for (let k = 1; k < groups.length; k++) {
      const from = types.map((b) => {
        let best = 0;
        for (let a = 1; a < types.length; a++) if (acc[a] + switchCost(types[a], b) < acc[best] + switchCost(types[best], b)) best = a;
        return best;
      });
      back.push(from);
      acc = types.map((b, j) => acc[from[j]] + switchCost(types[from[j]], b) + local[k][j].cost);
    }
    let j = acc.indexOf(Math.min(...acc));
    const q = new Array(us.length);
    const typeOfCluster = new Array(us.length);
    const beatTypes = new Map();
    for (let k = groups.length - 1; k >= 0; k--) {
      groups[k].idx.forEach((i, m) => {
        q[i] = local[k][j].qs[m];
        typeOfCluster[i] = types[j];
      });
      beatTypes.set(groups[k].beat.start, types[j]);
      if (k) j = back[k - 1][j];
    }
    return { q, typeOfCluster, beatTypes, beats: groups.length };
  }

  /** 1拍以上離れた節点どうしの傾きから、演奏のテンポの範囲（10〜90パーセンタイル）を求める */
  function tempoRange(maps, ts, ss) {
    const fileBpm = 60000000 / maps.usAt(0);
    const rates = [];
    for (let i = 0, j = 0; i < ts.length; i++) {
      while (j < ts.length && ts[j] - ts[i] < maps.ppq) j++;
      if (j >= ts.length) break;
      rates.push((60000000 / maps.usAt(ss[i])) * ((ss[j] - ss[i]) / (ts[j] - ts[i])));
    }
    if (!rates.length) return { min: fileBpm, max: fileBpm, file: fileBpm };
    rates.sort((a, b) => a - b);
    const pick = (p) => rates[Math.min(rates.length - 1, Math.floor(p * rates.length))];
    return { min: pick(0.1), max: pick(0.9), file: fileBpm };
  }

  /**
   * @param {Array<{tick:number}>} notes
   * @param {{types:string[], follow:number}} opts follow: テンポの揺れへの追従（0=追従しない〜1）
   * @returns 各ノートの揃え先 q[i]、終了位置の寄せ先 snapEnd()、演奏位置→楽譜位置 warp()、判定の統計
   */
  function quantize(notes, maps, opts) {
    const types = opts.types;
    if (!notes.length) throw new Error('ノートが含まれていません');
    for (const k of types) if (!(k in GRIDS)) throw new Error('未対応のグリッド: ' + k);
    const follow = clamp(opts.follow || 0, 0, 1);
    const clusters = clusterize(notes, maps);
    // 高音側だけの発音 = 旋律とみなす。高音側 = 平均音高より上（中央値だと、旋律の音が多い曲で旋律の中に境目ができる）
    const mean = notes.reduce((a, n) => a + n.pitch, 0) / notes.length;
    // ドラム（ch10）は音高が音域を表さないので、すべて伴奏として扱う
    const isLow = (n) => notes[n].ch === 9 || notes[n].pitch <= mean;
    for (const c of clusters) {
      const low = c.idx.filter(isLow);
      c.hi = !low.length;
      // 伴奏を含む発音は、伴奏の音の位置を基準にする（同時に鳴らした旋律の前のめりをテンポの揺れに含めない）
      if (low.length) c.t = Math.min(...low.map((n) => notes[n].tick));
      // 同じ発音の中で旋律（高音側）が伴奏より早ければ、その量を記録する（下から上へばらした和音では上の音が遅れるので使わない）
      const high = c.idx.filter((n) => !isLow(n));
      if (low.length && high.length) {
        const lead = maps.tickToMs(c.t) - maps.tickToMs(Math.min(...high.map((n) => notes[n].tick)));
        if (lead > 0) c.lead = lead;
      }
    }
    const accompanied = clusters.some((c) => !c.hi);
    for (const c of clusters) c.melody = c.hi && accompanied;
    const ts = clusters.map((c) => c.t);
    let ss = follow > 0 ? track(clusters, maps, types, follow) : ts.slice();
    let warp = makeWarp(ts, ss);
    let res;
    let us;
    for (let it = 0; ; it++) {
      const ws = ts.map(warp);
      const off = voiceOffsets(clusters, maps, types, ws);
      us = ws.map((u, i) => u + off[i]);
      res = viterbi(clusters, maps, types, us);
      if (follow === 0 || it === ITERATIONS - 1) break;
      // テンポの対応は伴奏の位置で引き直す（旋律の前のめりはテンポの揺れに含めない）
      ss = refit(clusters, maps, res.q.map((q, i) => q - off[i]), warp);
      warp = makeWarp(ts, ss);
    }

    // 主なグリッド（固定長などの単位）: 1割以上の拍で使われた中で最も細かいもの
    const count = {};
    for (const key of res.beatTypes.values()) count[key] = (count[key] || 0) + 1;
    const used = types.filter((k) => count[k] >= 0.1 * res.beats);
    const main = used.length ? used.reduce((a, b) => (GRIDS[b] > GRIDS[a] ? b : a)) : types[0];

    const q = new Array(notes.length);
    const qType = new Array(notes.length);
    let ambiguous = 0;
    let offGrid = 0;
    clusters.forEach((c, i) => {
      const u = us[i];
      const beat = beatOf(maps, u);
      const g = Math.min(gridTicksOf(maps.ppq, res.typeOfCluster[i]), beat.end - beat.start);
      if (Math.abs(u - res.q[i]) > AMBIGUOUS * g) ambiguous++;
      if (Math.abs(u - res.q[i]) > OFF_GRID * g) offGrid++;
      for (const n of c.idx) {
        q[n] = res.q[i];
        qType[n] = res.typeOfCluster[i];
      }
    });

    return {
      q,
      /** 各ノートの開始位置に選んだグリッドの種類（'16t' 等） */
      qType,
      warp,
      main,
      /** 終了位置: 楽譜上の位置に直し、その拍で選んだグリッド（なければ主なグリッド）に寄せる */
      snapEnd(tick) {
        const u = warp(tick);
        const beat = beatOf(maps, u);
        const g = gridTicksOf(maps.ppq, res.beatTypes.get(beat.start) || main);
        return { q: snapInBeat(beat, u, g), g: Math.min(g, beat.end - beat.start) };
      },
      usage: AUTO_TYPES.filter((k) => count[k]).map((k) => ({ key: k, label: GRID_LABEL[k], ratio: count[k] / res.beats })),
      tempo: tempoRange(maps, ts, ss),
      ambiguous,
      /** グリッドから離れた位置にあった同時発音のまとまりの数（ambiguous を含む） */
      offGrid,
      /** 同時発音のまとまりの数（ambiguous・offGrid の割合の分母） */
      clusters: clusters.length,
    };
  }

  // 最小音価ごとの候補。3連は同じ細かさの段に含める（8分 ↔ 8分3連、16分以上 ↔ 16分3連まで）
  const MIN_GRID_TYPES = { 8: ['4', '8'], 16: ['4', '8', '16'], 32: ['4', '8', '16', '32'] };
  const MIN_GRID_TRIPLETS = { 8: ['8t'], 16: ['8t', '16t'], 32: ['8t', '16t'] };
  const MIN_GRID_OF = { 4: '8', 8: '8', '8t': '8', 16: '16', '16t': '16', 32: '32' };

  /** 最小音価（'8' | '16' | '32'）と3連の有無から、判定に使うグリッドの一覧 */
  function quantizeTypes(minGrid, triplet) {
    if (!MIN_GRID_TYPES[minGrid]) throw new Error('未対応の最小音価: ' + minGrid + '（auto / 8 / 16 / 32）');
    const straight = MIN_GRID_TYPES[minGrid];
    return AUTO_TYPES.filter((k) => straight.includes(k) || (triplet && MIN_GRID_TRIPLETS[minGrid].includes(k)));
  }

  MH.GRIDS = GRIDS;
  MH.GRID_LABEL = GRID_LABEL;
  MH.gridTicksOf = gridTicksOf;
  MH.quantizeTypes = quantizeTypes;
  /** グリッドの種類が属する最小音価の段（例: '16t' → '16'） */
  MH.minGridOf = (key) => MIN_GRID_OF[key];
  MH.quantize = quantize;
})(typeof window !== 'undefined' ? window : globalThis);
