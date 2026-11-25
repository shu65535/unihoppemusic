/**
 * ピアノの右手(R)／左手(L)の推定。
 * 同時発音（クラスタ）ごとに「下から何音目までを左手にするか（分割位置）」を選び、
 * 手の届く範囲・指の数・直前からの移動量・音域の傾向をコストとして、曲全体で最小になる並びを Viterbi で求める。
 * 「右手＝旋律中心」（style: 'melody'）では、和音の最高音を右手（旋律）とし、それ以外は左手が届く限り左手に寄せる。
 * 右手が旋律を伸ばしている間に下で動く音（アルペジオ等）も左手を優先する。
 * Phase 2（演奏データからの手別の学習）でも同じ関数を使う前提で、UIには依存しない。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const DEFAULT_CENTER = { L: 48, R: 67 }; // 曲頭の各手の想定位置（C2 / G3）
  const W = {
    span: 4, // 1オクターブを超えた分（半音あたり）
    spanHard: 20, // 10度（16半音）を超えた分（半音あたり）。片手ではほぼ届かない
    fingers: 50, // 片手6音以上（1音あたり）
    move: 0.35, // 直前の中心からの移動（半音あたり）
    leap: 1.5, // 1オクターブを超える跳躍（半音あたり、move に上乗せ）
    register: 0.5, // 右手が G2 未満・左手が F3 超（半音あたり）
    middle: 0.2, // 右手が境目より下・左手が境目より上（半音あたり）。どちらの手でも弾ける音を音域で振り分ける弱い傾向
    idle: 2, // 押さえているだけの手に新しい音を割り当てる
  };
  // 「右手＝旋律中心」で上乗せするコスト
  const W_MELODY = {
    span: 12, // 届く幅を超えた分（半音あたり）。rhExtra より大きくし、届かない音だけを右手に回す
    rhExtra: 10, // 和音の最高音以外を右手が弾く（1音あたり）
    lhTop: 4, // 2音以上の和音を最高音まで左手だけで弾く
    underMelody: 4, // 右手が伸ばしている旋律の音の内側で鳴る、それより下の新しい音を右手が弾く（1音あたり）
  };
  // 左右の境目は曲の平均音高に合わせる（高音域だけで書かれた曲で、左手が C3 より上に居続けることがあるため）。C#3〜F#3 に制限
  const MIDDLE_MIN = 61;
  const MIDDLE_MAX = 66;
  const R_LOW = 55;
  const L_HIGH = 65;
  // 計算量の上限: 持ち回る「直近の音」の数、押さえ続けている音とみなす期間（拍）、片手に割り当てる最大音数（分割位置の候補）
  const MAX_RECENT = 24;
  const HELD_BEATS = 4;
  const MAX_PER_HAND = 8;

  const noteKey = (n, tick) => n.track + ':' + n.ch + ':' + n.pitch + ':' + Math.round(tick == null ? n.tick : tick);

  // Math.min(...arr) は大きな配列で RangeError になるため、ループで求める
  function minMax(a, b) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const list of [a, b]) {
      if (!list) continue;
      for (const p of list) {
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
    }
    return [lo, hi];
  }

  /** @param {{span:number, melody:boolean}} cfg span: 片手で届く幅（半音） */
  function spanCost(lo, hi, cfg) {
    const s = hi - lo;
    return Math.max(0, s - cfg.span) * (cfg.melody ? W_MELODY.span : W.span) + Math.max(0, s - cfg.span - 4) * W.spanHard;
  }

  /** 片手分の音（held: 前から鳴り続けている同じ手の音高）の局所コスト */
  function handCost(pitches, held, hand, middle, cfg) {
    if (!pitches.length) return 0;
    let c = Math.max(0, pitches.length - 5) * W.fingers;
    const [lo, hi] = minMax(pitches, held);
    c += spanCost(lo, hi, cfg);
    for (const p of pitches) {
      const over = hand === 'R' ? middle - p : p - middle; // 反対の手の側へはみ出した量
      c += Math.max(0, over) * W.middle + Math.max(0, hand === 'R' ? R_LOW - p : p - L_HIGH) * W.register;
    }
    return c;
  }

  /** 手の位置（直近に弾いた音域 ref）から、新しい音（の平均）までの移動コスト。音域の内側なら0 */
  function moveCost(ref, pitches) {
    if (!pitches.length) return 0;
    const to = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    const [lo, hi] = minMax(ref);
    const d = Math.max(0, lo - to, to - hi);
    return d * W.move + Math.max(0, d - 12) * W.leap;
  }

  /** 分割位置 k（下から k 音が左手）の候補。大きな和音では片手 MAX_PER_HAND 音以下に絞り、それも無理なら半分で分ける */
  function splitCandidates(m) {
    const lo = Math.max(0, m - MAX_PER_HAND);
    const hi = Math.min(m, MAX_PER_HAND);
    if (lo > hi) return [m >> 1];
    const ks = [];
    for (let k = lo; k <= hi; k++) ks.push(k);
    return ks;
  }

  /**
   * 音高だけから推定する（自動）。各ノートに hand: 'R'|'L' を付ける。
   * @param {object[]} notes { pitch, tick, endTick, keyEnd? }（keyEnd: 指で押さえていた終了位置。ペダルで伸びた分を除く）
   * @param {number} tolTicks 同時発音とみなす開始位置の差
   * @param {number} windowTicks 手の位置とみなす「直近に弾いた音」の範囲（1拍程度）
   * @param {{style?:'melody'|'balanced', span?:number}} [opts] style: 'melody' なら右手＝旋律中心。span: 片手で届く幅（半音、既定12）
   */
  function estimateHands(notes, tolTicks, windowTicks, opts) {
    const cfg = { melody: !!opts && opts.style === 'melody', span: (opts && opts.span) || 12 };
    const clusters = MH.clusterOnsets(notes, tolTicks);
    const avgPitch = notes.reduce((a, n) => a + n.pitch, 0) / Math.max(1, notes.length);
    const middle = Math.max(MIDDLE_MIN, Math.min(MIDDLE_MAX, avgPitch));
    // 各クラスタの状態 = 分割位置 k（下から k 音が左手）。
    // 状態ごとに最良経路の「各手が最後に弾いた音」「直近・鳴り続けている音」を持ち回る（厳密なViterbiではなく近似）
    let prev = [{ cost: 0, last: { L: [DEFAULT_CENTER.L], R: [DEFAULT_CENTER.R] }, recent: [], back: null, k: 0 }];
    for (const c of clusters) {
      const ps = c.notes.map((n) => n.pitch);
      const heldFrom = c.tick - windowTicks * HELD_BEATS;
      const ctx = prev.map((s) => {
        const isHeld = (h) => h.endTick > c.tick + tolTicks && h.tick >= heldFrom;
        const recent = s.recent.filter((h) => isHeld(h) || h.tick >= c.tick - windowTicks);
        const held = recent.filter(isHeld);
        const of = (list, hand) => list.filter((h) => h.hand === hand).map((h) => h.pitch);
        const refL = of(recent, 'L');
        const refR = of(recent, 'R');
        // 長い音を押さえているだけで直近に打鍵していない手（旋律の伸ばし中など）
        const idle = (hand) => held.some((h) => h.hand === hand) && !recent.some((h) => h.hand === hand && h.tick >= c.tick - windowTicks);
        const heldL = of(held, 'L');
        const heldR = of(held, 'R');
        return {
          s, recent, heldL, heldR, heldMaxL: minMax(heldL)[1], heldMinR: minMax(heldR)[0],
          heldNotesR: held.filter((h) => h.hand === 'R'),
          refL: refL.length ? refL : s.last.L, refR: refR.length ? refR : s.last.R, idleL: idle('L'), idleR: idle('R'),
        };
      });
      const cur = [];
      for (const k of splitCandidates(ps.length)) {
        const L = ps.slice(0, k);
        const R = ps.slice(k);
        let best = null;
        for (const x of ctx) {
          let cost = x.s.cost + handCost(L, x.heldL, 'L', middle, cfg) + handCost(R, x.heldR, 'R', middle, cfg) + moveCost(x.refL, L) + moveCost(x.refR, R);
          if (cfg.melody) {
            // 右手は最高音（旋律）だけを弾き、それ以外は左手が届く限り左手へ
            if (R.length) cost += (R.length - 1) * W_MELODY.rhExtra;
            else if (L.length >= 2) cost += W_MELODY.lhTop;
            // 右手が旋律を伸ばしている間の、それより下で鳴り終わる新しい音（アルペジオ・内声）は左手を優先。
            // 旋律のレガート（前の音に少し重ねて次の音を弾く）を左手に回さないよう、伸ばしている音の内側に収まる音だけを対象にする
            for (const n of c.notes.slice(k)) {
              const end = n.keyEnd ?? n.endTick;
              if (x.heldNotesR.some((h) => h.pitch > n.pitch && h.endTick >= end)) cost += W_MELODY.underMelody;
            }
          }
          // 鳴り続けている音と左右が逆転する（左手の音が右手の押さえている音より上）のは不自然（ps は昇順）
          if (L.length && L[L.length - 1] > x.heldMinR) cost += 15;
          if (R.length && R[0] < x.heldMaxL) cost += 15;
          // 押さえているだけの手より、弾き続けている手が次の音も弾くほうが自然
          if (L.length && x.idleL) cost += W.idle;
          if (R.length && x.idleR) cost += W.idle;
          if (!best || cost < best.cost) best = { cost, x };
        }
        const last = { L: L.length ? L : best.x.s.last.L, R: R.length ? R : best.x.s.last.R };
        let recent = best.x.recent.concat(c.notes.map((n, i) => ({ pitch: n.pitch, tick: n.tick, endTick: n.keyEnd ?? n.endTick, hand: i < k ? 'L' : 'R' })));
        if (recent.length > MAX_RECENT) recent = recent.slice(-MAX_RECENT);
        cur.push({ cost: best.cost, last, recent, back: best.x.s, k });
      }
      prev = cur;
    }
    // 逆にたどって分割位置を確定する
    let s = prev.reduce((a, b) => (b.cost < a.cost ? b : a));
    for (let i = clusters.length - 1; i >= 0; i--) {
      clusters[i].notes.forEach((n, j) => (n.hand = j < s.k ? 'L' : 'R'));
      s = s.back;
    }
    return notes;
  }

  /**
   * 手を割り当てる。優先順: ユーザー指定 > パート指定（左手・右手が別トラック/チャンネル）> 推定済みの手（fixed）> 推定（自動 or 固定の音高）
   * 各ノートに hand（確定値）、handAuto（指定がない場合の値）、handEst（パート指定を除いた推定値）、handUser（ユーザー指定で自動と異なる手か）を付ける。
   * ユーザー指定・推定済みの手のキーは元のMIDI上の開始位置（srcTick。正規化前）で引くため、正規化の設定を変えても外れない。
   * @param {{mode?:'melody'|'auto'|'split', splitPitch?:number, span?:number, tolTicks:number, windowTicks:number, parts?:Object<string,'R'|'L'>, overrides?:Map<string,'R'|'L'>, fixed?:Map<string,'R'|'L'>}} opts
   *   mode: 'melody' = 自動（右手＝旋律中心）、'auto' = 自動（均等）、'split' = 固定の音高で分ける。span: 片手で届く幅（半音）
   *   parts: 'トラック:チャンネル' → 手、overrides: noteKey → 手、fixed: noteKey → 以前に推定した手（あれば推定し直さない）
   */
  function assignHands(notes, opts) {
    const parts = opts.parts || {};
    const hinted = (n) => parts[n.track + ':' + n.ch];
    const fixedOf = (n) => opts.fixed && opts.fixed.get(noteKey(n, n.srcTick));
    const free = notes.filter((n) => !hinted(n));
    // 推定済みの手が無いノートがあるときだけ推定する（推定は前後の音に依存するので、パート全体で行う）
    if (free.some((n) => !fixedOf(n))) {
      if (opts.mode === 'split') for (const n of free) n.hand = n.pitch >= opts.splitPitch ? 'R' : 'L';
      else estimateHands(free, opts.tolTicks, opts.windowTicks, { style: opts.mode === 'melody' ? 'melody' : 'balanced', span: opts.span });
    }
    for (const n of free) n.handEst = fixedOf(n) || n.hand;
    return applyHands(notes, opts);
  }

  /**
   * 推定済みの手（各ノートの handEst、無ければ opts.fixed）に、パート指定・ユーザー指定を重ねて手を確定する（推定はしない）。
   * 付ける項目は assignHands と同じ
   * @param {{parts?:Object<string,'R'|'L'>, overrides?:Map<string,'R'|'L'>, fixed?:Map<string,'R'|'L'>}} opts
   */
  function applyHands(notes, opts) {
    const parts = opts.parts || {};
    const hinted = (n) => parts[n.track + ':' + n.ch];
    for (const n of notes) if (!hinted(n) && !n.handEst) n.handEst = opts.fixed && opts.fixed.get(noteKey(n, n.srcTick));
    for (const n of notes) {
      n.hand = hinted(n) || n.handEst;
      n.handAuto = n.hand;
      const user = opts.overrides && opts.overrides.get(noteKey(n, n.srcTick));
      // 自動判定（パート指定）と同じ手の指定は修正として扱わない
      n.handUser = !!user && user !== n.handAuto;
      if (user) n.hand = user;
    }
    return notes;
  }

  MH.estimateHands = estimateHands;
  MH.assignHands = assignHands;
  MH.applyHands = applyHands;
  MH.handNoteKey = noteKey;
})(typeof window !== 'undefined' ? window : globalThis);
