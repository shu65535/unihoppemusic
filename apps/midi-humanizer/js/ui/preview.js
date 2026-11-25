/**
 * ピアノロール表示（加工前の枠線＋加工後の塗り）、ベロシティレーン、CC・ピッチベンドのレーン、フレーズの区切りのレーン。
 * ノートの選択・ドラッグ編集とレーンの点の編集のための当たり判定も担う。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const ROW_H = 7; // 1音の行の高さの既定（縦ズームで変える）
  const MIN_ROW_H = 3;
  const MAX_ROW_H = 24;
  const VEL_H = 70; // ベロシティレーンの既定の高さ
  const LANE_H = 60; // CC・ピッチベンドのレーンの既定の高さ
  const MIN_LANE_H = 24; // レーンの高さの下限・上限（下端の境目のドラッグで変える）
  const MAX_LANE_H = 400;
  const GAP_H = 4; // レーンの下の隙間（ドラッグでそのレーンの高さを変える）
  const KEY_W = 72;
  const RULER_H = 40; // 上端の小節番号の帯（クリック・ドラッグで再生位置を指定する）
  const MAX_W = 30000; // ブラウザのcanvas幅上限対策
  const EDGE_PX = 4; // ノートの右端からこの幅以内なら長さの変更
  const POINT_PX = 5; // レーンの点の当たり判定の半径
  const PHRASE_PX = 5; // フレーズの区切り線の当たり判定の幅（左右それぞれ）
  const SPLIT_H = 4; // ノート領域とベロシティレーンの境目（ドラッグでノート領域の高さを変える）
  const FOLD_H = 14; // 折りたたんだレーンの高さ
  const MIN_ROWS = 6; // ノート領域の最小の高さ（行数）
  const BLACK_KEYS = [1, 3, 6, 8, 10]; // 黒鍵の音名（ピッチ % 12）
  const BLACK_KEY_W = 40; // 左端の列の鍵盤のうち黒鍵の長さ
  const FOOT_H = 20; // 下端の余白（左端の列のこの位置に、レーンの作成・設定のボタンを重ねる。CSS の .lane-tools と合わせる）
  const BTN_W = 14; // 左端の列のレーン名の右に並べるボタン（編集ロック・削除）の大きさ
  const BTN_H = 12;

  function velColor(v, alpha) {
    const t = v / 127;
    return `hsla(${30 - t * 25}, 95%, ${35 + t * 30}%, ${alpha})`;
  }
  // 右手=青系・左手=橙系。明るさ＝ベロシティ
  const HAND_HUE = { R: 212, L: 28 };
  function handColor(n, alpha) {
    const t = n.vel / 127;
    return `hsla(${HAND_HUE[n.hand]}, 85%, ${30 + t * 38}%, ${alpha})`;
  }
  // ギターのストローク方向: ダウン=青系・アップ=橙系（手と同じ色相）、単音（方向なし）=灰色。明るさ＝ベロシティ
  const STRUM_HUE = { D: 212, U: 28 };
  function strumColor(n, alpha) {
    const t = n.vel / 127;
    return n.strumDir ? `hsla(${STRUM_HUE[n.strumDir]}, 85%, ${30 + t * 38}%, ${alpha})` : `hsla(220, 8%, ${30 + t * 38}%, ${alpha})`;
  }

  /**
   * レーンの縦方向の座標変換（値 ⇔ キャンバスのy）
   * @param {number} h 開いているときの高さ
   * @param {number} pad 下端の余白
   * @param {number} inner 値の範囲を割り当てる高さ
   */
  function laneGeom(id, [lo, hi], top, h, folded, pad, inner) {
    const bottom = top + h - pad;
    return {
      id,
      top,
      h: folded ? FOLD_H : h,
      folded,
      lo,
      hi,
      yOf: (v) => bottom - ((v - lo) / (hi - lo)) * inner,
      valueAt: (py) => Math.max(lo, Math.min(hi, Math.round(lo + ((bottom - py) / inner) * (hi - lo)))),
    };
  }
  /** CC・ピッチベンドのレーン（上下に少し余白を取る） */
  const ccLaneGeom = (lane, top, h, folded) => laneGeom(lane.id, lane.range, top, h, folded, 2, h - 6);
  /** ベロシティレーン（棒の高さ＝ベロシティ） */
  const velLaneGeom = (top, h, folded) => laneGeom('vel', [0, 127], top, h, folded, 0, h - 4);

  /**
   * @param {object} data
   *   colorMode: 'vel' | 'hand' | 'strum' | 'part'、articMarks: ギターのミュート奏法の記号を描くか、drumPart: ドラムのとき 音の高さ → 割り当てたパーツ（null なら未割り当て。鍵盤列をパーツの色で塗る）、selected: 選択中ノートのキー集合、keyOf: ノート → キー
   *   lanes: [{id, label, role, color, range:[lo,hi], points:[{tick,value,ramp?}], phrase?}] 表示するCC・ピッチベンドのレーン（role は種類名の下に添える役割。ramp の点へは直線でつなぐ）。
     phrase: {starts:number[]} があればフレーズの区切りのレーン（starts: 各フレーズの開始位置）。id が抑揚（MH.lanes.EXPR）のレーンは、0の線を引き、最初の点より前を最初の点の値で描く
   *     section: {spans:[{start, end, label, fixed}], mergeable} があればヒューマナイズの区間のレーン（end は Infinity なら曲の終わりまで。fixed は拍子の変わる位置の消せない境目。mergeable なら結合のボタンを出す。閉じられないので削除のボタンは無い）
   *   viewW: 表示枠の幅。曲が短い・縮小したときも、枠の右端まで拍線・レーンを描き足す
   *   viewH: 表示枠の高さ。noteViewH（ノート領域の高さ）が無ければ、レーンが枠に収まるようノート領域の高さを決める
   *   pitchScroll: ノート領域の縦スクロール量（px。null ならノートのある音域の中央）、folded: 折りたたんだレーンのID（ベロシティは 'vel'）の集合
   *   laneH: レーンのID → 開いているときの高さ（px。無ければ既定の高さ）
   *   locked: 編集をロックしたレーンのIDの集合（点の編集を受け付けない）
   *   pointSel: 選択中のレーンの点 {id, points:Set}（null なら無し）
   * @returns 当たり判定用の座標変換（hitNotes・hitLane・hitPoint 等に渡す）
   */
  function drawRoll(canvas, data) {
    const { before, after, maps, zoom, showOriginal } = data;
    const lanes = data.lanes || [];
    const folded = data.folded || new Set();
    const locked = data.locked || new Set();
    const byHand = data.colorMode === 'hand' && after.some((n) => n.hand);
    const byStrum = data.colorMode === 'strum' && after.some((n) => n.strumDir);
    const drumPart = data.drumPart || null;
    const byPart = data.colorMode === 'part' && !!drumPart;
    // パーツ別: 色相＝パーツ（未割り当ては「その他パーカッション」の灰色）、明るさ＝ベロシティ
    const color = (n, alpha) =>
      byPart ? MH.drumPartColor(drumPart(n.pitch) || 'perc', 30 + (n.vel / 127) * 38, alpha) : byHand && n.hand ? handColor(n, alpha) : byStrum ? strumColor(n, alpha) : velColor(n.vel, alpha);
    const all = before.concat(after);
    // 行は MIDI の全音域。初めて見せるときはノートのある音域の中央に合わせる
    const minP = 0;
    const maxP = 127;
    const midP = all.length ? (MH.minOf(all, (n) => n.pitch) + MH.maxOf(all, (n) => n.pitch)) / 2 : 60;
    const lastPoint = Math.max(0, ...lanes.map((l) => MH.maxOf(l.points, (c) => c.tick)));
    // ドラッグ中に伸び縮みしないよう、編集前の長さ（data.minEndTick）より短くはしない
    const endTick = Math.max(MH.maxOf(all, (n) => n.endTick), lastPoint, data.minEndTick || 0) + maps.ppq;
    const scale = Math.min(zoom, (MAX_W - KEY_W) / endTick);
    // 縦の配分: 小節番号の帯 → ノート領域（中で縦スクロール） → 境目 → ベロシティ → 各レーン → 下端の余白
    const laneH = data.laneH || {};
    const openH = (id, def) => Math.max(MIN_LANE_H, Math.min(MAX_LANE_H, Math.round(laneH[id] ?? def)));
    const velFolded = folded.has('vel');
    const velOpenH = openH('vel', VEL_H);
    const velH = velFolded ? FOLD_H : velOpenH;
    const belowH = SPLIT_H + velH + lanes.reduce((s, l) => s + GAP_H + (folded.has(l.id) ? FOLD_H : openH(l.id, LANE_H)), 0) + GAP_H + FOOT_H;
    // ノート領域の高さ: 既定は枠に合わせる（下のレーンまで枠に収める）。境目のドラッグで広げるのは、ノート領域が表示枠の高さに収まるところまで
    // （それ以上はノート領域が枠の外にはみ出し、右端のバーも隠れるため。押し出されたレーンは枠のスクロールで見る）
    const fitH = data.viewH ? data.viewH - RULER_H - belowH : 0;
    const maxH = data.viewH ? data.viewH - RULER_H - SPLIT_H : Infinity;
    const wantH = Math.max(0, Math.min(maxH, data.noteViewH ?? fitH));
    // 1音の行の高さ（縦ズーム）。縮小は全音域がノート領域にちょうど収まるまで（それ以上は下に余白ができるだけなので）
    const rows = maxP - minP + 1;
    const rowH = Math.min(MAX_ROW_H, Math.max(MIN_ROW_H, Math.ceil(wantH / rows), Math.round(data.rowH || ROW_H)));
    const fullH = rows * rowH;
    const noteH = Math.round(Math.max(Math.min(fullH, MIN_ROWS * rowH), Math.min(fullH, wantH)));
    const scrollMax = fullH - noteH;
    const scrollY = Math.max(0, Math.min(scrollMax, Math.round(data.pitchScroll ?? (maxP - midP + 0.5) * rowH - noteH / 2)));
    const rollH = RULER_H + noteH;
    const W = Math.max(Math.ceil(KEY_W + endTick * scale), Math.floor(data.viewW || 0));
    const drawEnd = (W - KEY_W) / scale; // 描き足した分も含めた右端の位置（tick）
    const H = rollH + belowH;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const g = canvas.getContext('2d');
    const x = (t) => KEY_W + t * scale;
    const y = (p) => RULER_H + (maxP - p) * rowH - scrollY;
    // ノート領域の外（帯・レーン）にはみ出して描かないよう切り抜く
    const clipNotes = () => {
      g.save();
      g.beginPath();
      g.rect(0, RULER_H, W, noteH);
      g.clip();
    };

    g.fillStyle = '#111317';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#0a0b0d';
    g.fillRect(0, 0, W, RULER_H);
    g.font = '9px sans-serif';
    // 行の背景（白鍵=グレー、黒鍵=黒）と左端の列の鍵盤
    clipNotes();
    g.fillStyle = '#e8e8e8';
    g.fillRect(0, RULER_H, KEY_W, noteH);
    for (let p = minP; p <= maxP; p++) {
      const black = BLACK_KEYS.includes(p % 12);
      g.fillStyle = black ? '#121419' : '#1e2128';
      g.fillRect(KEY_W, y(p), W, rowH);
      // ドラムで割り当てた白鍵はパーツの色
      const part = drumPart && !black && drumPart(p);
      if (part) {
        g.fillStyle = MH.drumPartColor(part, 68);
        g.fillRect(0, y(p), KEY_W, rowH);
      }
    }
    // 白鍵の境目: 隣り合う白鍵（E-F・B-C）は行の境目、黒鍵を挟む場合は黒鍵の中央
    g.fillStyle = '#9a9a9a';
    for (let p = minP; p <= maxP; p++) {
      const pc = p % 12;
      if (BLACK_KEYS.includes(pc)) g.fillRect(BLACK_KEY_W, y(p) + Math.floor(rowH / 2), KEY_W - BLACK_KEY_W, 1);
      else if (pc === 4 || pc === 11) g.fillRect(0, y(p), KEY_W, 1);
    }
    // 音名は右寄せ。右端との間に半角1文字分の余白を空ける
    const nameRight = KEY_W - 5 - g.measureText('0').width;
    g.textAlign = 'right';
    for (let p = minP; p <= maxP; p++) {
      const pc = p % 12;
      if (BLACK_KEYS.includes(pc)) {
        const part = drumPart && drumPart(p);
        g.fillStyle = part ? MH.drumPartColor(part, 42) : '#1a1a1a';
        g.fillRect(0, y(p), BLACK_KEY_W, rowH);
      }
      if (pc === 0) {
        g.fillStyle = '#4a4f5a';
        g.fillText('C' + (p / 12 - 2), nameRight, y(p) + rowH, nameRight - BLACK_KEY_W - 1);
      }
    }
    g.textAlign = 'left';
    g.restore();
    // ベロシティ・CC・ピッチベンドのレーンの配置と背景（拍線を上に重ねるため先に塗る）
    const vy = rollH + SPLIT_H;
    const velGeom = velLaneGeom(vy, velOpenH, velFolded);
    const laneGeoms = [];
    let ly = vy + velH + GAP_H;
    for (const lane of lanes) {
      const lg = ccLaneGeom(lane, ly, openH(lane.id, LANE_H), folded.has(lane.id));
      if (lane.phrase) lg.phrase = true;
      if (lane.section) lg.section = true;
      lg.locked = locked.has(lane.id);
      laneGeoms.push(lg);
      ly += lg.h + GAP_H;
    }
    g.fillStyle = '#0d0f12';
    for (const lg of [velGeom, ...laneGeoms]) g.fillRect(KEY_W, lg.top, W, lg.h);
    // 小節線・拍線
    // 線の間隔が詰まりすぎる場合は拍線を省き、反復回数にも上限を設ける（異常な拍子・長大な曲で固まらないように）
    let prevMeter = null;
    for (let t = 0, guard = 0; t <= drawEnd && guard < 20000; guard++) {
      const pos = maps.position(t);
      const meterLabel = pos.meter !== prevMeter ? pos.meter : null; // 1小節目と拍子の変わる小節頭に拍子を書く
      prevMeter = pos.meter;
      const beatLines = pos.pulseTicks * scale >= 4 ? pos.pulses : 1;
      for (let b = 0; b < beatLines; b++) {
        const bt = pos.barStartTick + b * pos.pulseTicks;
        g.strokeStyle = b === 0 ? '#3d4350' : '#2b2f38';
        g.beginPath();
        g.moveTo(x(bt) + 0.5, RULER_H);
        g.lineTo(x(bt) + 0.5, H);
        g.stroke();
        // 上端の帯: 小節頭は縦いっぱいの線と小節番号（線の右下）、拍は上寄りの短い目盛り
        g.strokeStyle = b === 0 ? '#c8ccd4' : '#7d838e';
        g.beginPath();
        g.moveTo(x(bt) + 0.5, b === 0 ? 4 : 6);
        g.lineTo(x(bt) + 0.5, b === 0 ? RULER_H : 18);
        g.stroke();
        if (b === 0) {
          g.fillStyle = '#d6d9df';
          g.font = '12px sans-serif';
          g.fillText(String(pos.bar + 1), x(bt) + 5, RULER_H - 7);
          // 拍子は小節番号の上に、角丸のタグで書く（拍の目盛りに重なっても読めるよう塗りつぶす）
          if (meterLabel) {
            g.font = '11px sans-serif';
            const tw = Math.ceil(g.measureText(meterLabel).width) + 8;
            g.beginPath();
            g.roundRect(x(bt) + 3.5, 3.5, tw, 16, 3);
            g.fillStyle = '#3a3d44';
            g.fill();
            g.strokeStyle = '#5c616b';
            g.stroke();
            g.fillStyle = '#e4e6ea';
            g.fillText(meterLabel, x(bt) + 7.5, 15);
          }
          g.font = '9px sans-serif';
        }
      }
      t = pos.barStartTick + pos.barTicks;
    }
    // ノート領域・各レーンの仕切り（左端の列まで通す。ドラッグで高さを変えられることも示す）。拍線より上に描く
    const divider = (top, h = GAP_H) => {
      g.fillStyle = '#1b1e25';
      g.fillRect(0, top, W, h);
      g.fillStyle = '#6a707c';
      g.fillRect(0, top + (h >> 1) - 1, W, 2);
    };
    divider(rollH, SPLIT_H);
    for (const lg of [velGeom, ...laneGeoms]) divider(lg.top + lg.h);
    // ノート
    clipNotes();
    if (showOriginal) {
      g.strokeStyle = 'rgba(160,170,190,0.55)';
      for (const n of before) g.strokeRect(x(n.tick) + 0.5, y(n.pitch) + 0.5, Math.max(1, (n.endTick - n.tick) * scale), rowH - 1);
    }
    const selected = data.selected && data.selected.size ? data.selected : null;
    for (const n of after) {
      const w = Math.max(1.5, (n.endTick - n.tick) * scale);
      g.fillStyle = color(n, 0.85);
      g.fillRect(x(n.tick), y(n.pitch) + 1, w, rowH - 2);
      if (n.userEdited) {
        // ユーザーが位置・長さを修正したノート
        g.strokeStyle = '#ffffff';
        g.strokeRect(x(n.tick) + 0.5, y(n.pitch) + 1.5, Math.max(1, w - 1), rowH - 3);
      }
      if (selected && selected.has(data.keyOf(n))) {
        g.strokeStyle = '#ffe066';
        g.lineWidth = 2;
        // 行が低いときは枠を行の外側に描く（中に描くと潰れて見分けられない）
        if (rowH <= 4) g.strokeRect(x(n.tick) - 1, y(n.pitch) - 1, w + 2, rowH + 2);
        else g.strokeRect(x(n.tick) - 1, y(n.pitch), w + 2, rowH);
        g.lineWidth = 1;
      }
    }
    // ギターのミュート奏法: 同時に鳴る音（articId）ごとに、最も高い音の上へ記号を書く（ブラッシング＝×、パームミュート＝PM）
    if (data.articMarks) {
      const tops = new Map();
      for (const n of after) {
        if (n.artic !== 'X' && n.artic !== 'P') continue;
        const t = tops.get(n.articId);
        if (!t) tops.set(n.articId, { tick: n.tick, pitch: n.pitch, artic: n.artic });
        else {
          t.tick = Math.min(t.tick, n.tick);
          t.pitch = Math.max(t.pitch, n.pitch);
        }
      }
      g.font = 'bold 10px sans-serif';
      g.textBaseline = 'bottom';
      for (const t of tops.values()) {
        const label = t.artic === 'X' ? '×' : 'PM';
        const tx = x(t.tick);
        const ty = y(t.pitch);
        g.fillStyle = 'rgba(11,18,32,0.75)';
        g.fillRect(tx - 1, ty - 11, g.measureText(label).width + 2, 11);
        g.fillStyle = t.artic === 'X' ? '#ff7675' : '#81ecec';
        g.fillText(label, tx, ty);
      }
      g.textBaseline = 'alphabetic';
    }
    g.restore();
    // 左端の列のレーン名（クリックで折りたたみ）。CC・ピッチベンド・フレーズのレーンは、開いているとき右に編集ロック・削除のボタンを並べる（区間のレーンは結合のボタンだけ）
    const folds = [];
    const label = (id, text, color, top, h, isFolded, isLocked, merge) => {
      const fold = { id, top, h };
      folds.push(fold);
      const withButtons = isLocked != null && !isFolded;
      g.fillStyle = color;
      // ボタンと重ならないよう、長い名前は詰めて収める
      g.fillText((isFolded ? '▶' : '▼') + text, 2, top + 11, withButtons ? KEY_W - 2 * BTN_W - 6 : undefined);
      if (!withButtons) return;
      const by = top + 1;
      // 区間のレーンは閉じられない（ベロシティと同じ）ので、削除の代わりに結合のボタンだけ（区間が1つのときは出さない）
      if (merge != null) {
        if (!merge) return;
        fold.merge = { x: KEY_W - BTN_W - 2, y: by };
        drawMergeButton(g, fold.merge.x, by);
        return;
      }
      fold.del = { x: KEY_W - BTN_W - 2, y: by };
      drawDeleteButton(g, fold.del.x, by);
      fold.lock = { x: KEY_W - 2 * BTN_W - 3, y: by };
      drawLockButton(g, fold.lock.x, by, isLocked, color);
    };
    // ベロシティレーン
    label('vel', 'vel', '#8b93a3', vy, velH, velFolded);
    if (!velFolded) {
      const vb = vy + velOpenH;
      for (const n of after) {
        const top = velGeom.yOf(n.vel);
        g.fillStyle = color(n, 0.9);
        g.fillRect(x(n.tick), top, 2, vb - top);
      }
      if (showOriginal) {
        g.fillStyle = 'rgba(200,200,220,0.6)';
        for (const n of before) g.fillRect(x(n.tick) - 1, velGeom.yOf(n.vel), 4, 1);
      }
    }
    // CC・ピッチベンドのレーン（階段状。スロープの点へは直線。点はクリック・ドラッグで編集できる）・フレーズの区切りのレーン
    lanes.forEach((lane, li) => {
      const lg = laneGeoms[li];
      label(lane.id, lane.label, lane.color, lg.top, lg.h, lg.folded, lg.locked, lane.section ? lane.section.mergeable : undefined);
      if (lg.folded) return;
      // 種類名の下に役割（モジュレーション等）。長い名前は列の幅に詰めて収める
      if (lane.role) {
        g.fillStyle = lane.color;
        g.fillText(lane.role, 4, lg.top + 22, KEY_W - 6);
      }
      if (lane.phrase) return drawPhraseLane(g, lane, lg, x, MH.maxOf(all, (n) => n.endTick));
      if (lane.section) return drawSectionLane(g, lane, lg, x, Math.max(MH.maxOf(all, (n) => n.endTick), drawEnd));
      // 最初の点より前の値（ピッチベンドは中央、抑揚は最初の点の値。core/edit.js の laneValueAt と同じ）
      const expr = lane.id === MH.lanes.EXPR;
      const base = lane.id === 'pb' ? 0 : expr ? (lane.points.length ? lane.points[0].value : 0) : lg.lo;
      if (lane.id === 'pb' || expr) {
        g.strokeStyle = '#2a2e37';
        g.beginPath();
        g.moveTo(KEY_W, Math.round(lg.yOf(0)) + 0.5);
        g.lineTo(W, Math.round(lg.yOf(0)) + 0.5);
        g.stroke();
      }
      g.strokeStyle = lane.color;
      g.beginPath();
      let prevY = lg.yOf(base);
      g.moveTo(KEY_W, prevY);
      lane.points.forEach((c, i) => {
        const yy = lg.yOf(c.value);
        if (!c.ramp || !i) g.lineTo(x(c.tick), prevY);
        g.lineTo(x(c.tick), yy);
        prevY = yy;
      });
      g.lineTo(W, prevY);
      g.stroke();
      // 点（スロープの点は枠だけの四角）。選択中の点は、ノートの選択と同じ色で大きめに描く
      const sel = data.pointSel && data.pointSel.id === lane.id ? data.pointSel.points : null;
      lane.points.forEach((c, i) => {
        if (sel && sel.has(c)) return;
        if (c.ramp && i) g.strokeRect(x(c.tick) - 2.5, lg.yOf(c.value) - 2.5, 5, 5);
        else g.fillRect(x(c.tick) - 1.5, lg.yOf(c.value) - 1.5, 3, 3);
      });
      if (sel) {
        g.save();
        g.fillStyle = g.strokeStyle = '#ffe066';
        lane.points.forEach((c, i) => {
          if (!sel.has(c)) return;
          if (c.ramp && i) g.strokeRect(x(c.tick) - 3.5, lg.yOf(c.value) - 3.5, 7, 7);
          else g.fillRect(x(c.tick) - 2.5, lg.yOf(c.value) - 2.5, 5, 5);
        });
        g.restore();
      }
    });
    // 範囲選択ツールで選んだ区間（上端の帯にも印を付ける。ループがオンなら強調する）
    const range = data.range;
    if (range && range.end > range.start) {
      const rx = x(range.start);
      const rw = Math.max(1, x(range.end) - rx);
      g.fillStyle = 'rgba(110,168,254,0.10)';
      g.fillRect(rx, RULER_H, rw, H - RULER_H);
      g.fillStyle = range.loop ? 'rgba(110,168,254,0.85)' : 'rgba(139,147,163,0.6)';
      g.fillRect(rx, RULER_H - 5, rw, 5);
      g.fillStyle = 'rgba(110,168,254,0.7)';
      g.fillRect(Math.round(rx), RULER_H, 1, H - RULER_H);
      g.fillRect(Math.round(rx + rw) - 1, RULER_H, 1, H - RULER_H);
    }
    if (data.headers) drawHeaders(canvas, data.headers);
    return {
      x,
      y,
      scale,
      rollH,
      rulerH: RULER_H,
      keyW: KEY_W,
      endTick,
      height: H,
      lanes: laneGeoms,
      vel: velGeom,
      tickAt: (px) => Math.max(0, (px - KEY_W) / scale),
      pitchAt: (py) => Math.max(minP, Math.min(maxP, maxP - Math.floor((py - RULER_H + scrollY) / rowH))), // 縦位置の行の音高（0〜127）
      noteH,
      pitchScroll: scrollY,
      scrollMax,
      fullH,
      rowH,
      folds,
    };
  }

  /**
   * フレーズの区切りのレーン: フレーズごとに交互の帯・区切り線（上端に掴む印）。山なりは抑揚のレーンに出す
   * @param {number} songEnd 最後のフレーズの帯の終わり（曲の最後の音の終わり）
   */
  function drawPhraseLane(g, lane, lg, x, songEnd) {
    const starts = lane.phrase.starts;
    starts.forEach((s, i) => {
      const e = i + 1 < starts.length ? starts[i + 1] : Math.max(songEnd, s);
      const x0 = x(s);
      const x1 = x(e);
      g.fillStyle = i % 2 ? 'rgba(248,165,194,0.07)' : 'rgba(248,165,194,0.16)';
      g.fillRect(x0, lg.top, x1 - x0, lg.h);
    });
    g.fillStyle = lane.color;
    for (const s of starts) {
      const xs = Math.round(x(s));
      g.fillRect(xs, lg.top, 1, lg.h);
      g.beginPath();
      g.moveTo(xs - 4, lg.top);
      g.lineTo(xs + 5, lg.top);
      g.lineTo(xs + 0.5, lg.top + 6);
      g.fill();
    }
  }

  /**
   * ヒューマナイズの区間のレーン: 区間ごとに交互の帯・区切り線・左上に名前（番号・プリセット名・強度）
   * @param {number} viewEnd 最後の区間の帯の終わり（Infinity の代わり）
   */
  function drawSectionLane(g, lane, lg, x, viewEnd) {
    const spans = lane.section.spans;
    g.save();
    g.beginPath();
    g.rect(KEY_W, lg.top, g.canvas.width - KEY_W, lg.h);
    g.clip();
    g.font = '11px sans-serif';
    spans.forEach((sp, i) => {
      const x0 = x(sp.start);
      const x1 = x(Math.min(sp.end, viewEnd));
      g.fillStyle = i % 2 ? 'rgba(255,184,108,0.08)' : 'rgba(255,184,108,0.20)';
      g.fillRect(x0, lg.top, x1 - x0, lg.h);
      g.fillStyle = lane.color;
      // 拍子の変わる位置の境目（結合しても消えない）は太線
      g.fillRect(Math.round(x0) - (sp.fixed ? 1 : 0), lg.top, sp.fixed ? 3 : 1, lg.h);
      if (x1 - x0 > 14) g.fillText(sp.label, x0 + 4, lg.top + 13, x1 - x0 - 6);
    });
    g.restore();
  }

  /** 区間の結合のボタン（左右から寄せる矢印） */
  function drawMergeButton(g, bx, by) {
    g.fillStyle = '#1b1e25';
    g.fillRect(bx, by, BTN_W, BTN_H);
    g.strokeStyle = '#8b93a3';
    const cy = by + BTN_H / 2;
    const cx = bx + BTN_W / 2;
    g.beginPath();
    g.moveTo(bx + 2, cy);
    g.lineTo(cx - 1, cy);
    g.moveTo(cx - 3.5, cy - 2.5);
    g.lineTo(cx - 1, cy);
    g.lineTo(cx - 3.5, cy + 2.5);
    g.moveTo(bx + BTN_W - 2, cy);
    g.lineTo(cx + 1, cy);
    g.moveTo(cx + 3.5, cy - 2.5);
    g.lineTo(cx + 1, cy);
    g.lineTo(cx + 3.5, cy + 2.5);
    g.stroke();
  }

  /** 編集ロックのボタン（錠前）。ロック中はレーンの色で塗り、錠を閉じる */
  function drawLockButton(g, bx, by, isLocked, color) {
    g.fillStyle = isLocked ? color : '#1b1e25';
    g.fillRect(bx, by, BTN_W, BTN_H);
    const fg = isLocked ? '#111317' : '#8b93a3';
    const cx = bx + BTN_W / 2;
    g.fillStyle = fg;
    g.fillRect(cx - 3.5, by + 5, 7, 5); // 本体
    g.strokeStyle = fg;
    g.beginPath();
    // つる（外したときは右側を浮かせる）
    g.moveTo(cx - 2, by + 5);
    g.lineTo(cx - 2, by + 3.5);
    g.arc(cx, by + 3.5, 2, Math.PI, 0);
    g.lineTo(cx + 2, isLocked ? by + 5 : by + 3.5);
    g.stroke();
  }

  /** レーンの削除のボタン（×） */
  function drawDeleteButton(g, bx, by) {
    g.fillStyle = '#1b1e25';
    g.fillRect(bx, by, BTN_W, BTN_H);
    g.strokeStyle = '#8b93a3';
    g.beginPath();
    g.moveTo(bx + 4, by + 3);
    g.lineTo(bx + BTN_W - 4, by + BTN_H - 3);
    g.moveTo(bx + BTN_W - 4, by + 3);
    g.lineTo(bx + 4, by + BTN_H - 3);
    g.stroke();
  }

  /**
   * 固定表示用のキャンバスに、描き終えたロールの上端の帯（ruler）・左端の列（keys）・その交わり（corner）を写す。
   * 3つは CSS の sticky で重ね、負のマージンでロールの上に載せる
   * @param {{corner:HTMLCanvasElement, ruler:HTMLCanvasElement, keys:HTMLCanvasElement}} headers
   */
  function drawHeaders(canvas, headers) {
    const W = canvas.width;
    const H = canvas.height;
    const parts = [
      [headers.corner, KEY_W, RULER_H],
      [headers.ruler, W, RULER_H],
      [headers.keys, KEY_W, H],
    ];
    for (const [c, w, h] of parts) {
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      c.style.marginBottom = -h + 'px';
      const g = c.getContext('2d');
      g.drawImage(canvas, 0, 0, w, h, 0, 0, w, h);
      // ロールとの境目の線
      g.strokeStyle = '#333844';
      g.beginPath();
      if (c !== headers.keys) {
        g.moveTo(0, h - 0.5);
        g.lineTo(w, h - 0.5);
      }
      if (c !== headers.ruler) {
        g.moveTo(w - 0.5, 0);
        g.lineTo(w - 0.5, h);
      }
      g.stroke();
    }
  }

  /**
   * キャンバス座標（px）の矩形に重なる加工後ノートを返す。点の判定は x0=x1, y0=y1 で渡す。
   * @param {{x:Function, y:Function, scale:number, rollH:number}} geom drawRoll の戻り値
   */
  function hitNotes(geom, notes, x0, y0, x1, y1) {
    const [l, r] = x0 <= x1 ? [x0, x1] : [x1, x0];
    // ノート領域の外（縦スクロールで隠れたノート）は選ばない
    const t = Math.max(Math.min(y0, y1), geom.rulerH);
    const b = Math.min(Math.max(y0, y1), geom.rollH);
    if (t > b) return [];
    return notes.filter((n) => {
      const nx = geom.x(n.tick);
      const nw = Math.max(3, (n.endTick - n.tick) * geom.scale);
      const ny = geom.y(n.pitch);
      return nx <= r && nx + nw >= l && ny <= b && ny + geom.rowH >= t;
    });
  }

  /** 点がノートの右端（長さを変える位置）にあるか */
  function onNoteEdge(geom, n, px) {
    const right = geom.x(n.endTick);
    // 短いノートでも移動できるよう、ノート幅の半分より左は右端として扱わない
    return px >= right - EDGE_PX && px <= right + 2 && px >= (geom.x(n.tick) + right) / 2;
  }

  const openLaneAt = (geom, py) => geom.lanes.find((l) => !l.folded && py >= l.top && py < l.top + l.h) || null;

  /** キャンバスのyにある、開いているCC・ピッチベンドのレーン（無ければ null）。折りたたんだ・ロックしたレーンは編集できない */
  function hitLane(geom, py) {
    const l = openLaneAt(geom, py);
    return l && !l.phrase && !l.section && !l.locked ? l : null;
  }

  /** キャンバスのyにある、開いているヒューマナイズの区間のレーン（無ければ null） */
  function hitSectionLane(geom, py) {
    const l = openLaneAt(geom, py);
    return l && l.section ? l : null;
  }

  /** キャンバスのyにある、開いているフレーズの区切りのレーン（無ければ null。ロックしたレーンも null） */
  function hitPhraseLane(geom, py) {
    const l = openLaneAt(geom, py);
    return l && l.phrase && !l.locked ? l : null;
  }

  /** キャンバスのyにある、ロックした開いているレーン（無ければ null） */
  function hitLockedLane(geom, py) {
    const l = openLaneAt(geom, py);
    return l && l.locked ? l : null;
  }

  /** キャンバスのxにあるフレーズの区切りの添字（最も近いもの。無ければ -1） */
  function hitPhraseStart(geom, starts, px) {
    let best = -1;
    let bestD = PHRASE_PX;
    starts.forEach((s, i) => {
      const d = Math.abs(geom.x(s) - px);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  /** キャンバスのyにある、値を表示する開いたレーン（ベロシティを含む。無ければ null） */
  function hitValueLane(geom, py) {
    const v = geom.vel;
    if (!v.folded && py >= v.top && py < v.top + v.h) return v;
    const l = openLaneAt(geom, py); // ロックしたレーンも値は見せる
    return l && !l.phrase && !l.section ? l : null;
  }

  /** キャンバスのyが、開いているレーンの下端の境目（ドラッグでそのレーンの高さを変える）にあれば、そのレーン（無ければ null） */
  function hitLaneSplit(geom, py) {
    return [geom.vel, ...geom.lanes].find((l) => !l.folded && py >= l.top + l.h - 1 && py < l.top + l.h + GAP_H) || null;
  }

  /** キャンバスのyが、ノート領域とベロシティレーンの境目（ドラッグで高さを変える）にあるか。掴みやすいよう少し広めに取る */
  function onSplit(geom, py) {
    return py >= geom.rollH - 2 && py < geom.rollH + SPLIT_H + 1;
  }

  /** 左端の列で、キャンバスのyにあるレーン（クリックで折りたたみを切り替える）のID（無ければ null） */
  function hitFold(geom, py) {
    const f = geom.folds.find((f) => py >= f.top && py < f.top + f.h);
    return f ? f.id : null;
  }

  /**
   * 左端の列で、レーン名の右のボタン（編集ロック・区間の結合・削除）の当たり判定
   * @param {number} px 表示枠の左端からの位置（キャンバスのpx。左端の列は固定表示のため、ロール上のxではない）
   * @returns {{id:string, kind:'lock'|'merge'|'del'}|null}
   */
  function hitLaneButton(geom, px, py) {
    const on = (b) => b && px >= b.x && px < b.x + BTN_W && py >= b.y && py < b.y + BTN_H;
    for (const f of geom.folds) {
      if (on(f.lock)) return { id: f.id, kind: 'lock' };
      if (on(f.merge)) return { id: f.id, kind: 'merge' };
      if (on(f.del)) return { id: f.id, kind: 'del' };
    }
    return null;
  }

  /** レーン内の点の当たり判定。重なっていれば最も近い点の添字（無ければ -1） */
  function hitPoint(geom, lane, points, px, py) {
    let best = -1;
    let bestD = POINT_PX * POINT_PX;
    points.forEach((c, i) => {
      const d = (geom.x(c.tick) - px) ** 2 + (lane.yOf(c.value) - py) ** 2;
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  /** レーン内で、2点（キャンバスのpx）を角とする矩形に入る点 */
  function hitPointsIn(geom, lane, points, x0, y0, x1, y1) {
    const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
    return points.filter((c) => {
      const px = geom.x(c.tick);
      const py = lane.yOf(c.value);
      return px >= l && px <= r && py >= t && py <= b;
    });
  }

  MH.drawRoll = drawRoll;
  MH.hitPointsIn = hitPointsIn;
  MH.hitNotes = hitNotes;
  MH.onNoteEdge = onNoteEdge;
  MH.hitLane = hitLane;
  MH.hitPhraseLane = hitPhraseLane;
  MH.hitSectionLane = hitSectionLane;
  MH.hitPhraseStart = hitPhraseStart;
  MH.hitPoint = hitPoint;
  MH.onSplit = onSplit;
  MH.hitValueLane = hitValueLane;
  MH.hitLaneSplit = hitLaneSplit;
  MH.hitFold = hitFold;
  MH.hitLaneButton = hitLaneButton;
  MH.hitLockedLane = hitLockedLane;
  MH.ROW_H_RANGE = [MIN_ROW_H, ROW_H, MAX_ROW_H]; // 縦ズームの範囲と既定
})(typeof window !== 'undefined' ? window : globalThis);
