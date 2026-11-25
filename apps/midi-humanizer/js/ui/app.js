/**
 * 画面の制御。
 * ファイル読み込み・プリセット読み込み・モード変更（と対象チャンネルの変更）では自動で処理し直す。
 * 設定のヒューマナイズのパラメータ・強度・ドラムマップの変更も、値が決まったときに自動で処理し直す（autoRun。区間の乱数は引き継ぐ）。
 * それ以外（楽器固有の詳細設定など）の変更は「実行」ボタンで反映する。
 */
(function (root) {
  'use strict';
  const MH = root.MH;
  const $ = (id) => document.getElementById(id);
  // 設定「左手／右手」の欄のボタン。設定を描き直すと外れるため参照を持っておく（ピアノ以外では表示しないよう、いったん外す）
  const handActions = $('handActions');
  handActions.remove();
  // 設定「フレーズ検出」の欄のボタン（同上。ピアノ・ギターで表示する）
  const phraseActions = $('phraseActions');
  phraseActions.remove();
  // ギターの設定「ストロークの方向・奏法」の欄のボタン（同上。ギターで表示する）
  const strumActions = $('strumActions');
  strumActions.remove();

  const state = {
    fileName: '',
    src: null,
    // 楽器・対象パートは、ファイルを開いたときのモーダルで選ぶ（開き直すまで変えない）
    instrument: 'piano',
    part: null,
    extraPart: '', // ピアノの左手・右手が別パートのときの、もう片方（'' なら無し）
    programs: {}, // チャンネル → 試聴に使うサウンドフォントの音色のキー（ファイルを開いたときに決める）
    handParts: null, // 'トラック:チャンネル' → 'R'|'L'
    handOverrides: new Map(), // ノートのキー → 'R'|'L'（ユーザーが修正した手）
    // 分析段（core/analyze.js）の結果。ファイルの読み込み・加工対象の変更（resetAnalysis）・「再判定する」「再検出する」まで判定し直さない。分析は run の analyzeSource で行う
    analyzed: false, // 分析済み（false なら次の実行の前に、値の無いノートを分析する）
    handAuto: new Map(), // ノートのキー → 'R'|'L'（推定した手）
    handTargets: '', // handAuto を推定したときの加工対象
    strumOverrides: new Map(), // ノートのキー → 'D'|'U'（ユーザーが修正したギターのストローク方向）
    strumAuto: new Map(), // ノートのキー → 'D'|'U'（判定したストローク方向）
    articOverrides: new Map(), // ノートのキー → 'N'|'X'|'P'（ユーザーが修正したギターのミュート奏法）
    articAuto: new Map(), // ノートのキー → 'N'|'X'|'P'（判定したミュート奏法）
    // フレーズの区切り（各フレーズの開始位置。元のMIDI上の位置＝正規化前の tick）。ピアノ・ギターのヒューマナイズで使う
    phraseAuto: null, // 検出した区切り（分析段の結果）
    phraseEdits: null, // ユーザーが修正した区切り（null なら phraseAuto のまま）
    phraseDraft: null, // フレーズのレーンでドラッグしている途中の区切り（表示だけ）
    // 抑揚のレーンに描いた点（元のMIDI上の位置。null なら自動＝抑揚（自動）の設定の山なり）。処理し直しても残す。別のファイルを読み込むと消える
    exprEdits: null,
    // ノートのキー → { dt, dl }（ユーザーが修正した開始位置・長さの、ヒューマナイズ後からのずれ。tick）。
    // 処理し直しても最後に足し直す（core/edit.js の applyNoteOffsets）。別のファイルを読み込むと消える
    noteOffsets: new Map(),
    selection: new Set(), // ピアノロールで選択中のノートのキー
    // 選択中のレーンの点 { id, points:Set }（1つのレーンの中だけ。点のオブジェクトで持つので、元に戻す・処理し直すで差し替わった点は外れる）
    pointSel: null,
    geom: null,
    result: null,
    params: {},
    normParams: MH.defaultsOf(MH.NORMALIZE_SCHEMA),
    colorModes: { piano: 'hand', guitar: 'strum', drums: 'part' }, // ピアノロールの色分け（楽器ごとに覚える）
    customPresets: { piano: {}, guitar: {}, drums: {} },
    meter: null, // 設定に表示している区間の拍子（"3/4" など。プリセットの振り分け・拍のエディタに使う。区間が1つなら曲の主な拍子）
    songMeter: null, // 読み込んだ曲の主な拍子
    // 設定に表示している区間の始まり（元のMIDI上の tick）。範囲を選ぶとその先頭の区間になる。範囲なしの実行では、この区間だけ今の設定にする
    editSection: 0,
    applied: null, // 直近の実行に使った設定（手の修正だけを反映し直すときに使う）
    paramsDirty: false, // 実行後にパラメータが変更され、まだ反映していない
    edited: false, // レーン（CC・ピッチベンド）を手動編集した（実行し直すと破棄される。ノートの修正は noteOffsets に残る）
    prev: {}, // 変更をキャンセルしたときに戻すためのセレクトの値
    cursorTick: 0, // 再生を始める位置（停止すると再生バーはここに戻る）
    // ツールバー
    tool: 'smart', // 編集ツール: smart | range | pencil | eraser | zoom | line
    range: null, // 範囲選択ツールで選んだ区間 { start, end }（tick。ループ再生の区間。ファイルを開き直すと消える）
    paintMark: null, // 鉛筆で塗る印（ピアノ: 'R' | 'L'、ギター: 'D' | 'U' | 'N' | 'X' | 'P'。null ならクリックで反転）
    paintKeys: null, // 鉛筆で印を塗っている途中のノートのキー（選択の枠で示す）
    snapUserSet: false, // グリッドの値をユーザーが選んだ（以後、実行しても最小音価に合わせ直さない）
    // 実行結果に対する手動編集（加工後ノートの位置・長さ、CC・ピッチベンド）。表示・加工後の試聴・書き出しはこちらを使う
    edit: null, // { parts, notes, lanes: {レーン識別子: [{tick, value}]}, notesEdited, lanesEdited, ccCarried: 引き継いだレーンに手動編集あり, dirtyLanes: 書き出しで差し替えるレーン, endTick }
    laneIds: [], // 表示中のレーン
    knownLanes: new Set(), // 一度表示したレーン（閉じたレーンを実行のたびに開き直さないため）
    // ピアノロールの見た目だけの状態（データ・書き出しには影響しない）
    noteViewH: null, // ノート領域の高さ（px）。null なら枠に合わせる（境目をドラッグすると固定）
    pitchScroll: null, // ノート領域の縦スクロール量（px）。null ならノートのある音域の中央
    rowH: null, // 1音の行の高さ（px。右端の縦ズーム）。null なら既定
    folded: new Set(), // 折りたたんだレーンのID（ベロシティは 'vel'）。レーンを閉じても残す
    locked: new Set(), // 編集をロックしたレーンのID（点の編集を受け付けない。元に戻す・やり直しは効く）。レーンを閉じる・別の曲を読み込むと解除する
    laneH: {}, // レーンのID → 高さ（px。下端の境目をドラッグすると決まる。無ければ既定の高さ）
    exportScope: 'all', // 書き出しの範囲（'all': 読み込んだMIDIと同じ構成 / 'parts': 加工対象のトラックのみ）。直前に選んだものを次の既定にする
    exportHands: '1', // ピアノの「加工対象のトラックのみ」のトラック数（'1': 1トラックにまとめる / '2': 右手・左手の2トラック）。同上
    // MIDI編集モード（一次データ state.src を直接書き換える。core/source-edit.js）
    // 直近のヒューマナイズに使った一次データ（state.src と同じオブジェクトなら結果は最新。一次データは書き換えのたびに新しいオブジェクトになり、元に戻すと前のオブジェクトに戻る）
    humanSrc: null,
    srcGrid: null, // 直近のノーマライズで判定した最小音価など（MIDI編集モードのスナップのグリッドに使う）
  };
  /** モード: 'source'（MIDI編集: 一次データのノートを直接編集する。ノーマライズもここ）| 'humanize'（ヒューマナイズ編集） */
  const mode = () => $('mode').value;
  const sourceMode = () => mode() === 'source';
  const RUN_LABEL = { humanize: 'ヒューマナイズを実行', source: 'ノーマライズを実行' };

  // ---------- 実行の要否・破棄の確認 ----------
  function markDirty() {
    if (!state.src || sourceMode()) return; // 読み込み前は、最初の実行で必ず反映される。ノーマライズの設定は実行するまで使わないので数えない
    state.paramsDirty = true;
    syncRunUi();
  }

  /**
   * パラメータの値が決まったとき（スライダーを離した・選び直した等）に自動で処理し直す。
   * 実行ボタンと同じく範囲選択があれば範囲内、無ければ設定に表示している区間だけを今の設定にする。区間の乱数は引き継ぐ（値を変えた効果だけが変わる）。
   * レーンの手動編集が消えるときは確認し、やめたら未反映のまま（実行ボタンで反映できる）。再生中は今の位置から再生し直す。
   * キー操作などで続けて値が変わったときは、変わり終えてからまとめて1回処理する
   */
  let autoTimer = 0;
  let autoRunning = false; // 確認を待っている間（その間の変更は、確認の後の実行で一緒に反映する）
  function autoRun() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autoRunNow, 150);
  }
  async function autoRunNow() {
    if (autoRunning || !state.src || sourceMode() || !state.paramsDirty) return;
    autoRunning = true;
    try {
      if (!(await confirmDiscard(false)) || !state.src || sourceMode() || !state.paramsDirty) return;
      if (!run(false, false, false, true)) stopPlay(); // 結果を捨てたので、前の結果を鳴らし続けない
      else if (MH.player.isPlaying()) startPlay(MH.player.position());
    } finally {
      autoRunning = false;
    }
  }

  function syncRunUi() {
    const btn = $('runBtn');
    // 区間が2つ以上で範囲なしのときは、今の設定にする区間（syncEditSection を参照）
    const layers = !sourceMode() && sectionAvailable() && state.applied.human.layers;
    const sec = layers && layers.length > 1 && layerable() ? `（区間 ${sectionIndexAt(layers, state.editSection) + 1}）` : '';
    btn.textContent = RUN_LABEL[mode()] + (rangeApplies() ? '（選択範囲）' : sec);
    btn.setAttribute('aria-label', btn.textContent); // 右クリックメニューの項目名
    btn.disabled = !state.src;
  }

  /**
   * 実行を選択範囲に絞るか、絞るならそのしかた。
   * 'layer': 範囲を新しい区間にし、範囲外は直近のヒューマナイズの結果のまま（範囲があり、直近の区間に重ねられるとき）。
   * 'fresh': 範囲外は元のまま（MIDI編集モードのノーマライズ）。
   * null: 全体（範囲が無いとき。直近のヒューマナイズに重ねられないとき）
   */
  const rangeMode = (m = mode()) => {
    if (!state.range || state.range.end <= state.range.start) return null;
    if (m === 'source') return 'fresh';
    return layerable() ? 'layer' : null;
  };
  /** 直近のヒューマナイズの区間に重ねられるか（直近の実行と楽器・対象パート・一次データが同じ） */
  const layerable = () =>
    !!state.result &&
    !!state.applied &&
    state.humanSrc === state.src &&
    state.applied.human.instrument === instrument() &&
    JSON.stringify(state.applied.targets) === JSON.stringify(targets());
  const rangeApplies = (m = mode()) => !!rangeMode(m);

  /** レーンの手動編集が残っているか（ロック・範囲外で引き継いだレーンの編集を含む）。ノートの修正は処理し直しても残るので含めない */
  const hasEdits = () => state.edited || !!(state.edit && state.edit.ccCarried);

  /**
   * 処理し直すとレーンの手動編集が失われるか（編集したのがロックしたレーンだけなら失われない）
   * @param {boolean} [keepsLanes] 処理し直しても対象パートが変わらない（レーンを引き継げる）操作か
   */
  const losesEdits = (keepsLanes = true) =>
    hasEdits() && !(keepsLanes && !!state.edit && state.edit.dirtyLanes.size > 0 && [...state.edit.dirtyLanes].every((id) => state.locked.has(id)));

  /**
   * ピアノロール・レーン上で手動編集した
   * @param {string} [laneId] 編集したレーン（省略時はノートの編集）
   */
  function markEdited(laneId) {
    if (laneId) {
      state.edit.dirtyLanes.add(laneId);
      state.edit.lanesEdited = true;
      state.edited = true;
    } else state.edit.notesEdited = true;
    syncRunUi();
  }

  /**
   * 処理し直す前に、失われるもの（未反映のパラメータ・手動編集）があれば確認する。
   * @param {boolean} losesParams パラメータを上書きする操作（プリセット・楽器の変更）か
   * @param {boolean} [keepsLanes] losesEdits を参照
   * @param {boolean} [whole] 範囲選択によらず全体を処理し直す操作か（手の修正の反映など）
   * @returns {Promise<boolean>} 続けてよければ true
   */
  async function confirmDiscard(losesParams, keepsLanes, whole) {
    const lose = [];
    // プリセットで上書きされる値（プリセットから変えた値）が未反映のときだけ。楽器固有の詳細設定・強度はプリセットで変わらない
    if (losesParams && state.paramsDirty && presetDirty) lose.push('・未反映のパラメータ変更');
    if (losesEdits(keepsLanes)) lose.push(keepsLanes !== false && !whole && rangeMode() === 'layer' ? '・選択範囲内のレーン（CC・ピッチベンド）の編集' : '・レーン（CC・ピッチベンド）の編集');
    // 対象パートが変わる（別のファイルを開く）ときは、ノートの位置・長さの修正と、MIDI編集での変更も消える
    if (keepsLanes === false && state.noteOffsets.size) lose.push(`・ノートの位置・長さの修正（${state.noteOffsets.size} 件）`);
    if (keepsLanes === false && srcUndo.length) lose.push('・MIDI編集での変更');
    if (!lose.length) return true;
    return MH.modal.confirm({
      title: '編集の破棄',
      message: `次の内容は破棄されます。続けますか？\n${lose.join('\n')}`,
      okText: '破棄して続ける',
      danger: true,
    });
  }

  /** キャンセル時に戻せるよう、自動で処理し直すセレクトの現在値を覚える */
  function remember() {
    for (const id of ['mode', 'preset']) state.prev[id] = $(id).value;
  }

  /**
   * セレクトの変更を確認してから適用する。キャンセルなら元の値に戻す
   * @param {boolean|Function} [keepsLanes] 対象パートが変わらない操作か（losesEdits を参照）
   */
  function guardSelect(id, losesParams, apply, keepsLanes = true) {
    const value = (x) => (typeof x === 'function' ? x() : x);
    $(id).addEventListener('change', async () => {
      if (!(await confirmDiscard(value(losesParams), value(keepsLanes)))) {
        $(id).value = state.prev[id];
        return;
      }
      apply();
      remember();
    });
  }

  // ---------- 元に戻す・やり直し ----------
  // 履歴の種類:
  //   notes: ノートの位置・長さの修正 { items: [{ key: ノートのキー, before: 修正値 {dt, dl}|null, after }] }
  //   lane : レーンの点の追加・移動・削除 { id, before: 点の配列, after }
  //   phrase: フレーズの区切りの修正 { before: 区切りの配列|null（null は自動検出のまま）, after }。戻すたびに処理し直す
  //   expr : 抑揚のレーンの修正 { before: 点の配列|null（null は自動）, after }。戻すたびに処理し直す（処理し直しても消さない）
  // 手の修正は対象外。
  // ノートの修正は修正値（ヒューマナイズ後からのずれ）をキーで指すので、処理し直しても戻せる。
  // レーンは処理し直すと作り直されるため、引き継がなかったときはレーンの履歴だけを消す（pruneHistory）
  const MAX_HISTORY = 200;
  let undoStack = [];
  let redoStack = [];
  let droppedEdits = false; // 上限を超えて捨てた履歴に、レーンの編集があった（元に戻しきってもレーンの編集は残っている）
  // MIDI編集モードの履歴（ヒューマナイズ編集とは別）。一次データの書き換え1回が1件:
  //   { before, after: 一次データ, moves: [変更前のキー, 変更後のキー], drop: 消したノートのキー, dropped: 消した修正（rekeyMaps の戻り値）,
  //     phraseBefore, phraseAfter: フレーズの区切りの修正, exprBefore, exprAfter: 抑揚のレーンの修正 }
  // 一次データは丸ごと持つ（書き換えのたびに新しいオブジェクトを作るので、共有しても書き換わらない）
  const MAX_SRC_HISTORY = 50;
  let srcUndo = [];
  let srcRedo = [];
  // MIDI編集モードの間、ヒューマナイズ編集の結果と編集層を預かる（{ result, edit }。一次データが変わっていなければ戻ったときにそのまま使う）
  let humanStash = null;

  function pushHistory(entry) {
    undoStack.push(entry);
    if (undoStack.length > MAX_HISTORY && undoStack.shift().type === 'lane') droppedEdits = true;
    redoStack = [];
    syncUndoUi();
  }

  function clearHistory() {
    undoStack = [];
    redoStack = [];
    droppedEdits = false;
    syncUndoUi();
  }

  /** 処理し直した後: レーンを引き継がなかったら、レーンの履歴を消す（ノートの修正の履歴は残す） */
  function pruneHistory(keptLanes) {
    if (!keptLanes) {
      undoStack = undoStack.filter((h) => h.type !== 'lane');
      redoStack = redoStack.filter((h) => h.type !== 'lane');
      droppedEdits = false;
    }
    syncUndoUi();
  }

  function syncUndoUi() {
    const src = sourceMode();
    $('undoBtn').disabled = !(src ? srcUndo : undoStack).length || !state.edit;
    $('redoBtn').disabled = !(src ? srcRedo : redoStack).length || !state.edit;
    $('resetNotes').disabled = src || !state.noteOffsets.size || !state.edit;
  }

  /** レーンの手動編集が残っているか（レーンの履歴が1つでもあれば） */
  function syncEdited() {
    state.edited = droppedEdits || undoStack.some((h) => h.type === 'lane');
    syncRunUi();
  }

  /** ノートの修正値を設定し、編集層のノートの位置・長さに反映する（off が null なら修正を取り消す） */
  function setOffset(key, off, byKey) {
    if (off) state.noteOffsets.set(key, Object.assign({}, off));
    else state.noteOffsets.delete(key);
    const n = byKey.get(key);
    if (n) MH.setNoteOffset(n, off);
  }
  const notesByKey = () => new Map(state.edit.notes.map((n) => [noteKey(n), n]));

  /** @param {'before'|'after'} side どちらの状態にするか */
  function applyHistory(h, side) {
    const ed = state.edit;
    if (h.type === 'notes') {
      const byKey = notesByKey();
      for (const it of h.items) setOffset(it.key, it[side], byKey);
      ed.notesEdited = true;
    } else {
      ed.lanes[h.id] = h[side].map((c) => Object.assign({}, c));
      ed.dirtyLanes.add(h.id);
      ed.lanesEdited = true;
      syncLaneTools();
    }
    draw();
    if (MH.player.isPlaying()) startPlay(MH.player.position());
  }

  function undo() {
    if (sourceMode()) return stepSource(true);
    if (!undoStack.length || drag || !state.edit || phraseBusy) return;
    if (REPROCESS_TYPES.has(undoStack[undoStack.length - 1].type)) return stepReprocess(true);
    const h = undoStack.pop();
    redoStack.push(h);
    applyHistory(h, 'before');
    syncEdited();
    syncUndoUi();
  }
  function redo() {
    if (sourceMode()) return stepSource(false);
    if (!redoStack.length || drag || !state.edit || phraseBusy) return;
    if (REPROCESS_TYPES.has(redoStack[redoStack.length - 1].type)) return stepReprocess(false);
    const h = redoStack.pop();
    undoStack.push(h);
    applyHistory(h, 'after');
    syncEdited();
    syncUndoUi();
  }

  /**
   * ノートの修正値を変えて履歴に積む（変わらないノートは積まない）
   * @param {[string, {dt:number, dl:number}|null][]} changes ノートのキーと新しい修正値
   * @returns {boolean} 変わったノートがあったか
   */
  function changeOffsets(changes) {
    const same = (a, b) => (a ? a.dt + ':' + a.dl : '') === (b ? b.dt + ':' + b.dl : '');
    const items = changes
      .map(([key, after]) => ({ key, before: state.noteOffsets.get(key) || null, after }))
      .filter((it) => !same(it.before, it.after));
    if (!items.length) return false;
    const byKey = notesByKey();
    for (const it of items) setOffset(it.key, it.after, byKey);
    pushHistory({ type: 'notes', items: items.map((it) => ({ key: it.key, before: it.before && Object.assign({}, it.before), after: it.after && Object.assign({}, it.after) })) });
    markEdited();
    return true;
  }

  /** 選択したノート（選択が無ければすべてのノート）の位置・長さの修正を取り消す */
  async function resetNotes() {
    const ed = state.edit;
    if (!ed || drag || !state.noteOffsets.size || sourceMode()) return;
    const sel = selectedNotes().map(noteKey).filter((k) => state.noteOffsets.has(k));
    if (!sel.length) {
      if (state.selection.size) return; // 選択したノートに修正が無い
      const ok = await MH.modal.confirm({
        title: 'ノートの修正の取り消し',
        message: `すべてのノートの位置・長さの修正（${state.noteOffsets.size} 件）を取り消します。
（元に戻す／Ctrl+Z で戻せます）`,
        okText: 'すべて取り消す',
        danger: true,
      });
      if (!ok || state.edit !== ed || drag) return; // 確認を待つ間に処理し直した・ドラッグを始めた
    }
    if (!changeOffsets((sel.length ? sel : [...state.noteOffsets.keys()]).map((k) => [k, null]))) return;
    draw();
    if (MH.player.isPlaying()) startPlay(MH.player.position());
  }

  const copyPoints = (points) => (points || []).map((c) => Object.assign({}, c));
  /** レーンの点の入れ物（id をキーに点の配列を持つ。抑揚のレーンは CC・ピッチベンドと別に持ち、書き出し・試聴の CC に混ぜない） */
  const laneStore = (id) => (id === EXPR ? state.edit.exprLanes : state.edit.lanes);
  /** 抑揚のレーンを処理し直している途中か（その間は抑揚のレーンの点を触らせない） */
  const exprBusy = (lane) => !!lane && lane.id === EXPR && phraseBusy;
  /** レーンの点を変えた操作を確定する（抑揚のレーンは処理し直す。CC・ピッチベンドは履歴に積んで編集ありにする） */
  function commitLane(id, before) {
    if (id === EXPR) return commitExpr(before);
    if (pushLaneHistory(id, before)) markEdited(id);
  }
  /** レーンの点を変えた操作を履歴に積む（変わっていなければ積まない） */
  function pushLaneHistory(id, before) {
    const after = copyPoints(state.edit.lanes[id]);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    pushHistory({ type: 'lane', id, before, after });
    return true;
  }

  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('resetNotes').addEventListener('click', resetNotes);

  // ---------- サイドバーの開閉（状態はブラウザに保存） ----------
  const SIDE_KEY = 'mh.sideCollapsed';
  function setSideCollapsed(collapsed) {
    $('controls').classList.toggle('collapsed', collapsed);
    const t = $('sideToggle');
    t.title = collapsed ? '設定を開く' : '設定を閉じる';
    t.setAttribute('aria-label', t.title);
    t.setAttribute('aria-expanded', String(!collapsed));
  }
  $('sideToggle').addEventListener('click', () => {
    const collapsed = !$('controls').classList.contains('collapsed');
    setSideCollapsed(collapsed);
    try {
      localStorage.setItem(SIDE_KEY, collapsed ? '1' : '0');
    } catch (_) {
      // localStorage が使えない環境でも開閉は動かす
    }
  });
  try {
    setSideCollapsed(localStorage.getItem(SIDE_KEY) === '1');
  } catch (_) {
    // 保存値を読めなければ開いた状態のまま
  }

  // ---------- サイドバーの幅変更（左端のドラッグ。幅はブラウザに保存） ----------
  const SIDE_W_KEY = 'mh.sideWidth';
  const SIDE_W_DEFAULT = 340;
  const SIDE_W_MIN = 260;
  // ピアノロール側に最低限の幅を残す
  const sideWMax = () => Math.max(SIDE_W_MIN, Math.min(800, window.innerWidth - 400));
  function setSideWidth(w) {
    const clamped = Math.round(Math.min(sideWMax(), Math.max(SIDE_W_MIN, w)));
    $('controls').style.setProperty('--side-w', `${clamped}px`);
    return clamped;
  }
  function saveSideWidth(w) {
    try {
      localStorage.setItem(SIDE_W_KEY, String(w));
    } catch (_) {
      // localStorage が使えない環境でも幅変更は動かす
    }
  }
  {
    const r = $('sideResizer');
    let startX = 0;
    let startW = 0;
    let curW = 0;
    r.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startW = curW = $('controls').getBoundingClientRect().width;
      document.body.classList.add('side-resizing');
    });
    r.addEventListener('pointermove', (e) => {
      if (!r.hasPointerCapture(e.pointerId)) return;
      // サイドバーは右側にあるので、左へ動かすほど広くなる
      curW = setSideWidth(startW + (startX - e.clientX));
    });
    const end = (e) => {
      if (!r.hasPointerCapture(e.pointerId)) return;
      r.releasePointerCapture(e.pointerId);
      document.body.classList.remove('side-resizing');
      saveSideWidth(curW);
    };
    r.addEventListener('pointerup', end);
    r.addEventListener('pointercancel', end);
    r.addEventListener('dblclick', () => saveSideWidth(setSideWidth(SIDE_W_DEFAULT)));
  }
  try {
    const saved = Number(localStorage.getItem(SIDE_W_KEY));
    if (saved > 0) setSideWidth(saved);
  } catch (_) {
    // 保存値を読めなければ既定幅のまま
  }

  // ---------- ファイル読み込み ----------
  $('openFile').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // 同じファイルを選び直しても読み込めるように
    if (f) loadFile(f);
  });

  // 画面のどこにドロップしても読み込む
  const overlay = $('dropOverlay');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      overlay.classList.add('hidden');
    }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(mid|midi)$/i.test(f.name)) return showError('MIDIファイル（.mid / .midi）をドロップしてください');
    loadFile(f);
  });

  let loadSeq = 0; // 連続して読み込んだとき、後から選んだファイルだけを採用する

  async function loadFile(file) {
    const seq = ++loadSeq;
    closeInstDialog(); // 前のファイルの設定のモーダルは閉じる（読み込みのモーダルとキー操作を取り合わないように）
    MH.loadDialog.cancel(); // 前のファイルの読み込み設定は使わない（後のファイルが読めなくても残さない）
    try {
      // 大きすぎるファイルは中身を読む前に断る
      if (file.size > MH.MAX_FILE_BYTES) throw new Error('ファイルが大きすぎます（上限10MB）');
      const source = MH.loadSource(await file.arrayBuffer(), file.name);
      // 楽器・対象パートを選ぶ（キャンセルなら今のファイルのまま）
      const choice = await MH.loadDialog.open({
        info: source.info,
        parts: source.parts,
        instrument: instrument(),
        // 読み込む前に、選んでいる楽器の楽器固有の詳細設定（判定・検出の設定）を変えられるようにする（読み込んだらヒューマナイズ編集で開く）
        instSettings: { open: (inst) => INST_TABS.includes(inst) && openInstDialog(inst), isOpen: () => !!instDialog },
      });
      if (seq !== loadSeq || !choice) return;
      // 楽器が変わるとプリセットでパラメータが上書きされる
      const changesInstrument = choice.instrument !== instrument();
      if (!(await confirmDiscard(changesInstrument, false)) || seq !== loadSeq) return;
      openSource(source, choice, file.name);
      // 分析（手・ストローク方向・フレーズ）は、プリセットを適用した後の最初の実行の前に行う（run の analyzeSource）
      if (changesInstrument) onInstrumentChange();
      else run();
      remember();
    } catch (e) {
      showError('読み込みに失敗しました: ' + e.message);
    }
  }

  /**
   * 読み込んだ一次データ（MH.loadSource の結果）と読み込み設定を画面の状態にする。前のファイルの修正・分析結果・表示の状態は捨てる
   * @param {{midi:object, meter:string, info:string}} source
   * @param {{instrument:string, part:string, extraPart:string}} choice 読み込み設定のモーダルで選んだ値
   */
  function openSource(source, choice, fileName) {
    const { midi, meter, info } = source;
    stopPlay();
    state.src = midi;
    state.edit = null; // 前のファイルのレーンを引き継がない
    // 読み込んだらヒューマナイズ編集で開く（すぐにヒューマナイズして表示する）。MIDI編集の履歴・前のファイルの結果は捨てる
    $('mode').value = 'humanize';
    humanStash = null;
    srcUndo = [];
    srcRedo = [];
    state.humanSrc = null;
    state.srcGrid = null;
    syncNormGridWarn();
    state.edited = false;
    state.fileName = fileName.replace(/\.(mid|midi)$/i, '');
    state.meter = state.songMeter = meter;
    state.editSection = 0;
    fillPresetSelect();
    renderParams(); // 拍ごとのずれのエディタを曲の拍数に合わせる
    ['playToggle', 'download'].forEach((id) => ($(id).disabled = false));
    $('laneTools').classList.remove('hidden');
    $('emptyMsg').classList.add('hidden');
    state.handOverrides.clear();
    state.strumOverrides.clear();
    state.articOverrides.clear();
    state.phraseEdits = null;
    state.exprEdits = null;
    resetAnalysis();
    state.paintMark = null; // 楽器が変わると塗る印の値も変わるため、塗りをやめる
    state.noteOffsets.clear();
    clearHistory();
    state.selection.clear();
    state.pointSel = null;
    state.cursorTick = 0;
    state.range = null;
    state.snapUserSet = false; // 新しい曲の最小音価に合わせる
    state.pitchScroll = null; // 音域が変わるので中央から見せる
    state.laneIds = [];
    state.knownLanes.clear();
    state.locked.clear();
    state.part = choice.part;
    state.extraPart = choice.extraPart;
    state.instrument = choice.instrument;
    syncTargets();
    // 試聴に使うサウンドフォントの音色（チャンネルごと）。再生を押す前に読み込み始めておく
    state.programs = MH.sf2.programsOf(midi, instrument(), [].concat(targets()).map((key) => Number(key.split(':')[1])));
    MH.sf2.ensure(Object.values(state.programs).filter(Boolean));
    // ファイルの情報に続けて、選んだ楽器と使用チャンネル（対象パートのチャンネル。ピアノのもう片方の手を含む）を書く
    const channels = [...new Set([].concat(targets()).map((key) => Number(key.split(':')[1]) + 1))];
    $('fileInfo').textContent = `${info}\n楽器: ${instrumentName(instrument())}\n使用チャンネル: ${channels.map((ch) => 'ch' + ch).join(', ')}`;
    syncFileUi();
  }

  // ---------- ファイルを開くまで出さない欄 ----------
  const instrumentName = (key) => MH.loadDialog.INSTRUMENTS.find(([v]) => v === key)[1];

  /** ファイルを開くまで出さない欄（ノーマライズ・ヒューマナイズの大項目、ドラムマップ）と、楽器固有の詳細設定のボタンの表示を合わせる */
  function syncFileUi() {
    document.querySelectorAll('.file-only').forEach((el) => el.classList.toggle('hidden', !state.src));
    $('mode').disabled = !state.src; // モードはファイルを開いてから切り替える
    syncCatUi();
    syncPlayGroup();
    syncDrumMapVisibility();
    syncHandUi();
  }

  /** 加工対象のパート（ピアノで「もう片方の手」を選んだときは2つ） */
  function targets() {
    return state.extraPart && instrument() === 'piano' ? [state.part, state.extraPart] : state.part;
  }

  /** 左手・右手が別パートのとき、平均音高の高い方を右手とする */
  function computeHandParts() {
    state.handParts = null;
    const t = targets();
    if (!Array.isArray(t)) return;
    const notes = MH.extractNotes(MH.splitPart(state.src, t).midi);
    const avg = (key) => {
      const ns = notes.filter((n) => n.track + ':' + n.ch === key);
      return ns.reduce((a, n) => a + n.pitch, 0) / Math.max(1, ns.length);
    };
    const [hi, lo] = avg(t[0]) >= avg(t[1]) ? t : [t[1], t[0]];
    state.handParts = { [hi]: 'R', [lo]: 'L' };
  }

  /** 対象パートが変わったときの準備（ドラムマップ用のノート・手のパート） */
  function syncTargets() {
    const t = targets();
    drumMapUi.setNotes(MH.extractNotes(MH.splitPart(state.src, t).midi));
    // 加工対象が変わったら手を推定し直す（推定は前後の音に依存するので、対象のノート全体で行う）。ユーザーの修正は残す
    const targetsKey = JSON.stringify(t);
    if (state.handTargets !== targetsKey) resetAnalysis(); // ユーザーの修正は残す
    state.handTargets = targetsKey;
    computeHandParts();
  }

  // ---------- プリセット・パラメータ ----------
  function instrument() {
    return state.instrument;
  }

  // 選択中のプリセットと、その値からパラメータを変えたか
  let presetKey = null;
  let presetDirty = false;
  const PRESET_DIRTY = '*'; // セレクトで「変更後の値」を表す値（プリセットのキーとは重ならない）

  /**
   * 変更中は「名前*」をプリセットの「名前」の直前に足して選んでおく。「名前」を選び直すとプリセットの値に戻る。
   * 拍子（meter）で分けて並べる: 曲と同じ拍子 → 拍子共通 → 他の拍子（ファイル読み込み前は 拍子共通 → 拍子指定あり）
   */
  function fillPresetSelect() {
    const sel = $('preset');
    sel.innerHTML = '';
    const entries = [
      ...Object.entries(MH.PRESETS[instrument()]).map(([key, p]) => [key, p, p.name]),
      ...Object.entries(state.customPresets[instrument()]).map(([key, p]) => [key, p, '★ ' + p.name]),
    ];
    const groups = state.meter
      ? [[`${state.meter}（${state.src && meterCuts().length ? 'この区間' : 'この曲'}の拍子）`, (p) => p.meter === state.meter], ['拍子共通', (p) => !p.meter], ['他の拍子（合わないことがある）', (p) => p.meter && p.meter !== state.meter]]
      : [['拍子共通', (p) => !p.meter], ['拍子指定あり', (p) => !!p.meter]];
    for (const [label, match] of groups) {
      const list = entries.filter(([, p]) => match(p));
      if (!list.length) continue;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const [key, p, name] of list) {
        const text = p.meter ? `${name} [${p.meter}]` : name;
        if (key === presetKey && presetDirty) og.appendChild(new Option(text + '*', PRESET_DIRTY));
        og.appendChild(new Option(text, key));
      }
      sel.appendChild(og);
    }
    if (presetKey && presetByKey(presetKey)) sel.value = presetDirty ? PRESET_DIRTY : presetKey;
    state.prev.preset = sel.value; // 切り替えをキャンセルしたときに戻す値
    syncOverwritePreset();
    syncMeterWarn();
  }

  /** 選択中のプリセットの拍子が曲の拍子と違うときに注意を出す（プリセットを使わないMIDI編集モードでは出さない） */
  function syncMeterWarn() {
    const meter = presetByKey(presetKey)?.meter;
    const warn = $('presetMeterWarn');
    const mismatch = !!(meter && state.meter && meter !== state.meter && !sourceMode());
    warn.classList.toggle('hidden', !mismatch);
    warn.textContent = mismatch ? `このプリセットは ${meter} の曲から作ったものです（${state.src && meterCuts().length ? 'この区間' : 'この曲'}は ${state.meter}）。拍の位置で付ける揺れ・強弱が合わないことがあります` : '';
  }

  /** 上書き保存・削除は読み込んだプリセットだけ（組み込みのプリセットは書き換えない） */
  function syncOverwritePreset() {
    const custom = state.customPresets[instrument()][presetKey];
    $('overwritePreset').disabled = !custom || !presetDirty;
    $('deletePreset').disabled = !custom;
  }

  function presetByKey(key) {
    return MH.PRESETS[instrument()][key] || state.customPresets[instrument()][key];
  }
  // 楽器固有の詳細設定（スキーマの cat: 'instrument'。ファイル読み込み時の判定・検出、ペダル・ビブラート・奏法の出力の設定）は、プリセットと切り離して楽器ごとに値を持つ
  //   プリセットの切り替え・楽器の変更では初期値に戻さず、state.params へはここの値を重ねる。ファイルを開く前から編集できる
  const instGroups = (inst) => (MH.PARAM_SCHEMA[inst] || []).filter((g) => g.cat === 'instrument');
  const INST_PARAMS = Object.fromEntries(
    Object.keys(MH.PARAM_SCHEMA)
      .filter((inst) => instGroups(inst).length)
      .map((inst) => [inst, MH.defaultsOf(instGroups(inst))])
  );
  // パラメータの値には配列・オブジェクト（beatShift・accentGrid など）があるため、プリセット・画面の値・実行時の設定の間は中身まで複製して渡す
  // （浅いコピーだと、どれかを書き換えたときに組み込みのプリセットや保存済みのプリセットまで変わる）
  /** プリセットとして保存する値（楽器固有の詳細設定を除く） */
  const presetPart = (params) => structuredClone(Object.fromEntries(Object.entries(params).filter(([k]) => !(k in (INST_PARAMS[instrument()] || {})))));
  const presetParams = (key) => structuredClone(Object.assign(MH.defaultParams(instrument()), presetByKey(key)?.params, INST_PARAMS[instrument()]));

  /** オブジェクトのキーを並べ替えた JSON（キーの順序によらず中身で比べる） */
  const stableJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

  /** パラメータがプリセットの値から変わったかを調べ、セレクトの表示に反映する */
  function syncPresetDirty() {
    const base = presetParams(presetKey);
    // 波形・拍ごとのずれ（配列・オブジェクト）は中身で比べる
    const dirty = Object.keys(base).some((k) => stableJson(base[k]) !== stableJson(state.params[k]));
    if (dirty === presetDirty) return;
    presetDirty = dirty;
    fillPresetSelect();
  }

  /** プリセットの値を読み込んで処理し直す（プリセット読み込みは自動実行の対象） */
  // 次の run で、抑揚のレーンを平均でなく新しい自動の値に置き換える（プリセットの切り替え。run で戻す）
  let exprReplace = false;
  function applyPreset(key) {
    presetKey = key;
    presetDirty = false;
    fillPresetSelect();
    state.params = presetParams(key);
    renderParams();
    exprReplace = true;
    run();
  }

  function formatVal(it, v) {
    const s = it.step < 1 ? Number(v).toFixed(String(it.step).split('.')[1].length) : String(v);
    return (it.prefix || '') + s + (it.unit && it.unit !== 'note' ? ' ' + it.unit : it.unit === 'note' ? ' (' + noteName(v) + ')' : '');
  }
  function noteName(p) {
    return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][p % 12] + (Math.floor(p / 12) - 2);
  }

  function renderParams() {
    // グループの cat ごとに、設定の大項目へ振り分ける（instrument=一般の「楽器固有の詳細設定」のモーダル、それ以外=ヒューマナイズ）
    const schema = MH.PARAM_SCHEMA[instrument()];
    renderInstParams();
    renderSchema(schema.filter((g) => (g.cat || 'humanize') === 'humanize'), state.params, $('params'), syncPresetDirty, {}, autoRun);
    syncPlayGroup();
  }

  // モーダルに設定のある楽器（ピアノ・ギター: cat: 'instrument' のグループ、ドラム: ドラムマップ）。読み込みのモーダルの楽器の並び順
  const INST_TABS = MH.loadDialog.INSTRUMENTS.map(([v]) => v).filter((inst) => INST_PARAMS[inst] || inst === 'drums');
  // ファイルを開く前にモーダルで表示している楽器（タブで切り替える）。開いた後は開いているファイルの楽器を表示する
  let instTab = null;
  // 読み込み設定のモーダルから開いたときは、そこで選んでいる楽器（開いている間だけ）
  let instForced = null;
  const instShown = () => instForced || (state.src ? instrument() : instTab || (INST_TABS.includes(instrument()) ? instrument() : INST_TABS[0]));

  /** 楽器固有の詳細設定のモーダルの中身を描き直す */
  function renderInstParams() {
    const inst = instShown();
    const values = INST_PARAMS[inst];
    const host = $('instParams');
    syncDrumMapVisibility();
    if (!values) {
      host.innerHTML = '';
      return;
    }
    // 手・フレーズの「修正内容を削除」「再判定する」等は、ファイルを開いた後だけ（読み込み設定から開いたときは、これから読むファイルが対象なので出さない）
    const extras = state.src && !instForced ? { '「左手／右手」の判定': handActions, 'ストロークの方向・奏法': strumActions, 'フレーズ検出': phraseActions } : {};
    renderSchema(instGroups(inst), values, host, () => inst === instrument() && Object.assign(state.params, values), extras);
  }

  /**
   * 一般の「楽器固有の詳細設定」のボタンは、ヒューマナイズ編集のとき。
   * ファイルを開いてから、モーダルに設定のある楽器（ピアノ・ギター・ドラム）のときだけ（開く前は読み込みのダイアログのボタンから開く）
   */
  function syncPlayGroup() {
    const off = (!!state.src && !INST_TABS.includes(instrument())) || sourceMode();
    $('playGroup').classList.toggle('hidden', off || !state.src);
    if (off) closeInstDialog(); // 開く前は閉じない（読み込みのダイアログから開いたモーダルを残す）
  }

  // ---------- 楽器固有の詳細設定のモーダル ----------
  // 中身（#instPanel: #instParams とドラムマップ欄）は renderParams・ドラムマップのUIが描き直すため、作り直さずにモーダルへ移し、閉じたら元の場所へ戻す
  //   Esc・背景クリック・×・閉じるで閉じる。反映は「実行」ボタン
  let instDialog = null; // 表示中は { back, box, prevFocus }
  /** forced: 読み込み設定のモーダルから開くとき、そこで選んでいる楽器（タブは出さずにその楽器だけ表示する） */
  function openInstDialog(forced) {
    if (instDialog) return;
    if (forced) {
      instForced = forced;
      renderInstParams();
    }
    MH.info.hideTip();
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const back = el('div', 'modal-back');
    const box = el('div', 'modal inst-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.tabIndex = -1;
    const head = el('div', 'dm-modal-head');
    head.appendChild(el('h2', null, '楽器固有の詳細設定'));
    const x = el('button', 'dm-modal-x', '×');
    x.type = 'button';
    x.title = '閉じる（Esc）';
    x.addEventListener('click', closeInstDialog);
    head.appendChild(x);
    const body = el('div', 'dm-modal-body');
    const panel = $('instPanel');
    panel.classList.remove('hidden');
    body.appendChild(panel);
    // ファイルを開く前は楽器が決まっていないので、楽器ごとのタブで切り替える
    const tabs = el('div', 'inst-tabs');
    const showTabs = !state.src && !instForced;
    if (showTabs) {
      tabs.setAttribute('role', 'tablist');
      const shown = instShown();
      for (const inst of INST_TABS) {
        const t = el('button', 'inst-tab', instrumentName(inst));
        t.type = 'button';
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-selected', String(inst === shown));
        t.addEventListener('click', () => {
          instTab = inst;
          for (const b of tabs.children) b.setAttribute('aria-selected', String(b === t));
          renderInstParams();
        });
        tabs.appendChild(t);
      }
    }
    const foot = el('div', 'modal-buttons');
    const close = el('button', null, '閉じる');
    close.type = 'button';
    close.addEventListener('click', closeInstDialog);
    foot.appendChild(close);
    box.append(head, ...(showTabs ? [tabs] : []), body, foot);
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => e.target === back && closeInstDialog());
    document.addEventListener('keydown', onInstDialogKey, true);
    instDialog = { back, box, prevFocus: document.activeElement };
    document.body.appendChild(back);
    syncDrumMapVisibility(); // 中身を文書に入れてから（id で引くため）
    box.focus({ preventScroll: true });
  }

  function closeInstDialog() {
    if (!instDialog) return;
    drumMapUi.setActive(false); // ドラムマップの編集の履歴は表示している間だけ
    const { back, prevFocus } = instDialog;
    instDialog = null;
    MH.info.hideTip();
    document.removeEventListener('keydown', onInstDialogKey, true);
    const panel = $('instPanel');
    panel.classList.add('hidden');
    $('playGroup').after(panel);
    back.remove();
    if (instForced) {
      // 読み込み設定から開いた分の表示を、今の楽器の表示に戻す
      instForced = null;
      renderInstParams();
    }
    const target = prevFocus && prevFocus.isConnected && !prevFocus.closest('.hidden') ? prevFocus : null;
    if (target && target.focus) target.focus({ preventScroll: true });
  }

  // 画面側のショートカット（スペースで再生など）が反応しないよう、キャプチャ段階で止める
  function onInstDialogKey(e) {
    if (MH.modal.isOpen() || MH.info.isDialogOpen()) return; // 再判定の確認・項目の説明などはそちらに任せる
    // ドラムマップを表示している間の Ctrl+Z / Ctrl+Y はその編集の元に戻す・やり直し
    if (drumMapUi.handleKey(e)) {
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeInstDialog();
    } else if (e.key === 'Tab') {
      // フォーカスをモーダル内に閉じ込める（表示条件で隠れている項目は飛ばす）
      const items = [...instDialog.box.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary')].filter((n) => n.offsetParent !== null);
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? items.length - 1 : 1)) % items.length;
      if (items.length) items[next].focus();
    }
    e.stopPropagation();
  }

  $('openInstParams').addEventListener('click', () => openInstDialog());

  /**
   * 項目名のノード。ピアノの左手・右手の項目にはピアノロールと同じ色のタグを付ける。
   * 説明のある項目は名前の横に「?」（概要のツールチップ・詳細のモーダル）を付ける
   */
  function labelNodes(it) {
    const span = document.createElement('span');
    span.className = 'name';
    let title = it.label;
    if (it.hand) {
      const tag = document.createElement('span');
      tag.className = `hand-tag ${it.hand}`;
      tag.textContent = it.hand === 'right' ? '右手' : '左手';
      span.appendChild(tag);
      title = `${tag.textContent}：${it.label}`;
    }
    span.appendChild(document.createTextNode(it.label));
    MH.info.attach(span, it.desc, title);
    return [span];
  }

  /**
   * スキーマからフォームを生成し、操作に応じて values を書き換える（反映は onCommit。無ければ「実行」ボタン）
   * @param {()=>void} [onEdit] 値を変えるたびに呼ぶ
   * @param {Object<string, Node>} [extras] グループ名 → 項目の後ろに差し込むノード
   * @param {()=>void} [onCommit] 値が決まったとき（スライダー・ドラッグは離したとき）に呼ぶ
   */
  //   グループは既定で折りたたむ。描き直し（プリセット・楽器の切り替え）では、開いていたグループを開いたままにする
  let optSeq = 0; // renderSchema が入力欄に振る id の連番
  function renderSchema(schema, values, host, onEdit = () => {}, extras = {}, onCommit = () => {}) {
    MH.info.hideTip(); // 描き直しで消える「?」のツールチップが残らないようにする
    // 入れ子のグループは親と同じ名前のもの（ベロシティ・タイミングそれぞれの「キック」等）があるため、親からの経路で覚える
    const opened = new Set([...host.querySelectorAll('details.group[open]')].map((d) => d.dataset.path));
    host.innerHTML = '';
    // 表示条件（when）のある項目: 条件の select・チェックボックスを変えるたびに表示を切り替える
    const conds = [];
    const refreshers = []; // 他の項目の値で表示が変わるエディタの描き直し
    const boxes = []; // グループ（親より先に子が並ぶ順）
    const syncWhen = () => {
      for (const { it, nodes } of conds) for (const n of nodes) n.style.display = it.when.values.includes(values[it.when.key]) ? '' : 'none';
      // 中身がすべて隠れたグループ（ドラムの「クラッシュ」の音量だけ、など）はグループごと隠す
      for (const box of boxes) box.style.display = [...box.children].some((n) => n.tagName !== 'SUMMARY' && n.style.display !== 'none') ? '' : 'none';
      for (const r of refreshers) r();
    };
    const renderItems = (items, box) => {
      for (const it of items) {
        // 波形・拍ごとのずれ・ストロークのパターンはドラッグで操作するため、クリックが他の要素へ移る label ではなく div に入れる
        const EDITORS = { wave: waveEditor, beats: beatsEditor, strum: strumEditor, strumDir: strumEditor, strumArtic: strumEditor, accentGrid: strumEditor };
        const label = document.createElement(EDITORS[it.type] ? 'div' : 'label');
        const v = values[it.key];
        if (EDITORS[it.type]) {
          label.className = 'row';
          // live: ドラッグ中の途中の値（まだ決まっていない）
          const editor = EDITORS[it.type](it, values, (live) => {
            markDirty();
            onEdit();
            if (!live) onCommit();
          });
          if (editor.refresh) refreshers.push(editor.refresh);
          label.append(...labelNodes(it), editor);
        } else if (it.type === 'bool') {
          label.className = 'row check';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!v;
          cb.addEventListener('change', () => {
            values[it.key] = cb.checked;
            syncWhen();
            markDirty();
            onEdit();
            onCommit();
          });
          label.append(cb, ...labelNodes(it));
        } else if (it.type === 'select') {
          label.className = 'row';
          const sel = document.createElement('select');
          for (const [val, text] of it.options) {
            const o = document.createElement('option');
            o.value = val;
            o.textContent = text;
            sel.appendChild(o);
          }
          sel.value = v;
          sel.addEventListener('change', () => {
            values[it.key] = sel.value;
            syncWhen();
            markDirty();
            onEdit();
            onCommit();
          });
          label.append(...labelNodes(it), sel);
        } else {
          label.className = 'row';
          const head = document.createElement('span');
          head.className = 'head';
          const val = document.createElement('span');
          val.className = 'val';
          val.textContent = formatVal(it, v);
          head.append(...labelNodes(it), val);
          const r = document.createElement('input');
          r.type = 'range';
          r.min = it.min;
          r.max = it.max;
          r.step = it.step;
          r.value = v;
          r.addEventListener('input', () => {
            values[it.key] = Number(r.value);
            val.textContent = formatVal(it, r.value);
            markDirty();
            onEdit();
          });
          r.addEventListener('change', onCommit); // 離したとき（キー操作は1段ごと）
          label.append(head, r);
        }
        // 項目名の横の「?」（button）が label の対象にならないよう、入力欄と明示的に結び付ける
        const ctl = label.tagName === 'LABEL' && label.querySelector('input, select');
        if (ctl) label.htmlFor = ctl.id = `opt${++optSeq}`;
        box.appendChild(label);
        if (it.when) conds.push({ it, nodes: [label] });
      }
    };
    // 見出しの無いグループは項目を親へ直接並べ、groups は入れ子の折りたたみにする
    const renderGroups = (groups, parent, path = '') => {
      for (const g of groups) {
        if (!g.group) {
          renderItems(g.items || [], parent);
          continue;
        }
        const box = document.createElement('details');
        box.className = 'group';
        box.dataset.path = path + '/' + g.group;
        box.open = opened.has(box.dataset.path);
        const h = document.createElement('summary');
        h.textContent = g.group;
        box.appendChild(h);
        renderItems(g.items || [], box);
        renderGroups(g.groups || [], box, box.dataset.path);
        if (extras[g.group]) box.appendChild(extras[g.group]);
        parent.appendChild(box);
        boxes.push(box);
      }
    };
    renderGroups(schema, host);
    syncWhen();
  }

  /**
   * 手書きの波形エディタ（1周ぶん。上＝正）。ドラッグした区間の点を描き換え、離したときに onEdit を呼ぶ
   * values[it.key] は書き換えずに新しい配列で置き換える（プリセット・既定値の配列と共有しているため）
   */
  function waveEditor(it, values, onEdit) {
    const W = 256;
    const H = 80;
    const wrap = document.createElement('div');
    wrap.className = 'wave-edit';
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const draw = () => {
      const wv = values[it.key];
      g.fillStyle = '#0d0f12';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#2b2f38';
      g.fillRect(0, H / 2, W, 1);
      g.strokeStyle = '#a29bfe';
      g.beginPath();
      // 1周の終わりは始まりの点へつなぐ
      for (let i = 0; i <= wv.length; i++) {
        const px = (i / wv.length) * W;
        const py = H / 2 - wv[i % wv.length] * (H / 2 - 3);
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.stroke();
    };
    let prev = null; // ドラッグ中の直前の点 [index, value]
    const pointAt = (e) => {
      const r = c.getBoundingClientRect();
      const n = it.points;
      const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
      const v = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2));
      return [i, MH.roundWave(v)];
    };
    // 速く動かしても途切れないよう、直前の点との間を直線で埋める
    const paint = (e) => {
      const [i, v] = pointAt(e);
      const wv = values[it.key].slice();
      const [pi, pv] = prev || [i, v];
      const lo = Math.min(i, pi);
      const hi = Math.max(i, pi);
      for (let k = lo; k <= hi; k++) wv[k] = hi === lo ? v : MH.roundWave(pv + ((v - pv) * (k - pi)) / (i - pi));
      values[it.key] = wv;
      prev = [i, v];
      draw();
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      prev = null;
      paint(e);
    });
    c.addEventListener('pointermove', (e) => prev && paint(e));
    const end = () => {
      if (!prev) return;
      prev = null;
      onEdit();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    const reset = document.createElement('button');
    reset.type = 'button';
    MH.setIcon(reset, 'reset', '正弦波に戻す');
    reset.addEventListener('click', () => {
      values[it.key] = it.default.slice();
      draw();
      onEdit();
    });
    wrap.append(c, reset);
    draw();
    return wrap;
  }

  /** 開いている曲の1小節の拍数（主な拍子。ファイルを開く前は4） */
  function meterPulses() {
    const m = state.meter && /^(\d+)\/(\d+)$/.exec(state.meter);
    return m ? MH.meterPulses(Number(m[1]), Number(m[2])) : 4;
  }
  /** 開いている曲の1拍の長さ（4分音符単位。6/8 は付点4分で1.5。ファイルを開く前は1） */
  function pulseQuarters() {
    const m = state.meter && /^(\d+)\/(\d+)$/.exec(state.meter);
    if (!m) return 1;
    const num = Number(m[1]);
    const den = Number(m[2]);
    return ((num / MH.meterPulses(num, den)) * 4) / den;
  }

  /**
   * 拍ごとのずれのエディタ。▲＝拍頭のずれ、◆＝拍の途中の膨らみ。左右にドラッグし、離したときに onEdit を呼ぶ
   * 拍数は開いている曲の拍子に合わせる。数値はドラッグ中だけ表示する。
   * values[it.key] は書き換えずに新しいオブジェクトで置き換える（プリセット・既定値と共有しているため）
   */
  function beatsEditor(it, values, onEdit) {
    const n = meterPulses();
    const H = 64;
    const TOP = 16; // 拍番号の下端
    const MID_Y = 32; // ◆の高さ
    const BOTTOM = 48; // 拍の線の下端（▲の頂点）
    const wrap = document.createElement('div');
    wrap.className = 'beats-edit';
    const c = document.createElement('canvas');
    c.height = H;
    const g = c.getContext('2d');
    const cur = () => MH.beatShiftOf(values[it.key], n);
    // 横方向: 左右に PAD の余白、1拍の幅 bw。拍位置 x（0..n）は X(x)。最大のずれ（it.max ms）を拍の幅の45%で表す
    const PAD = 12;
    const geom = () => {
      const W = c.width;
      const bw = (W - PAD * 2) / n;
      return { W, bw, px: (bw * 0.45) / it.max, X: (x) => PAD + x * bw };
    };
    // 各つまみの位置（canvas 座標）
    const handles = () => {
      const b = cur();
      const { px, X } = geom();
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push({ kind: 'at', i, x: X(i) + b.at[i] * px, y: BOTTOM });
        out.push({ kind: 'mid', i, x: X(i + 0.5) + MH.beatShiftAt(b, i + 0.5) * px, y: MID_Y });
      }
      return out;
    };
    let drag = null; // { kind, i }
    const draw = () => {
      const w = Math.round(c.clientWidth);
      if (!w) return; // 折りたたみ中（表示されたら ResizeObserver で描く）
      if (c.width !== w) c.width = w;
      const b = cur();
      const { W, px, X } = geom();
      g.fillStyle = '#0d0f12';
      g.fillRect(0, 0, W, H);
      g.font = '11px sans-serif';
      g.textAlign = 'left';
      // 元の拍の線と拍番号（右端は次の小節の1拍目）
      for (let i = 0; i <= n; i++) {
        g.fillStyle = '#2b2f38';
        g.fillRect(Math.round(X(i)), TOP, 1, BOTTOM - TOP);
        g.fillStyle = '#8a8f98';
        if (i < n) g.fillText(String(i + 1), X(i) + 4, 11);
      }
      // ずらした後の16分の目盛り（拍の伸び縮みとスイングが見えるように。右端は次の小節の1拍目のずれ）
      g.fillStyle = 'rgba(162, 155, 254, 0.45)';
      const pq = pulseQuarters();
      for (let k = 0; k <= n * 4; k++) {
        const sw = (MH.swingShift(b, (k / 4) * pq) / pq) * geom().bw;
        const x = X(k / 4) + (k === n * 4 ? b.at[0] : MH.beatShiftAt(b, k / 4)) * px + sw;
        const tall = k % 4 === 0;
        g.fillRect(Math.round(x), tall ? TOP : TOP + 8, 1, tall ? BOTTOM - TOP : BOTTOM - TOP - 16);
      }
      // つまみ（ドラッグ中のつまみの横にだけ数値を出す）
      for (const h of handles()) {
        const active = drag && drag.kind === h.kind && drag.i === h.i;
        g.fillStyle = active ? '#ffffff' : h.kind === 'at' ? '#a29bfe' : '#74b9ff';
        g.beginPath();
        if (h.kind === 'at') {
          g.moveTo(h.x, h.y);
          g.lineTo(h.x - 6, h.y + 10);
          g.lineTo(h.x + 6, h.y + 10);
        } else {
          g.moveTo(h.x, h.y - 6);
          g.lineTo(h.x + 5, h.y);
          g.lineTo(h.x, h.y + 6);
          g.lineTo(h.x - 5, h.y);
        }
        g.fill();
        if (active) {
          const ms = h.kind === 'at' ? b.at[h.i] : b.mid[h.i];
          const text = `${ms > 0 ? '+' : ''}${ms}ms`;
          g.fillStyle = '#ffffff';
          g.textAlign = h.x > W - 50 ? 'right' : 'left';
          g.fillText(text, h.x + (h.x > W - 50 ? -9 : 9), h.y + (h.kind === 'at' ? 10 : 4));
          g.textAlign = 'left';
        }
      }
    };
    new ResizeObserver(draw).observe(c);
    // 表示上の座標（CSS px）→ canvas 座標
    const xOf = (e) => {
      const r = c.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * H };
    };
    const hit = (e) => {
      const p = xOf(e);
      let best = null;
      for (const h of handles()) {
        const d = Math.hypot(h.x - p.x, (h.y + (h.kind === 'at' ? 5 : 0) - p.y) * 1.5);
        if (d <= 12 && (!best || d < best.d)) best = Object.assign(h, { d });
      }
      return best;
    };
    /** つまみ (kind, i) の値を ms にした新しい値で置き換える */
    // 値が変わったら true
    const set = (kind, i, ms) => {
      const b = cur();
      const at = b.at.slice();
      const mid = b.mid.slice();
      const v = Math.round(Math.max(-it.max, Math.min(it.max, ms)));
      if ((kind === 'at' ? at : mid)[i] === v) return false;
      if (kind === 'at') at[i] = v;
      else mid[i] = v;
      put({ at, mid });
      return true;
    };
    /** 表示中の拍数の配置の一部（at・mid・swing・swingGrid）を置き換える。スイングは既定（50%・8分）なら持たない（プリセットと同じ形にそろえる） */
    const put = (patch) => {
      const b = Object.assign(cur(), patch);
      if (b.swing <= it.swingMin) delete b.swing;
      if (b.swingGrid !== 16) delete b.swingGrid;
      values[it.key] = Object.assign({}, values[it.key], { [n]: b });
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const h = hit(e);
      if (!h) return;
      c.setPointerCapture(e.pointerId);
      drag = { kind: h.kind, i: h.i, moved: false };
      draw();
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) {
        c.style.cursor = hit(e) ? 'ew-resize' : 'default';
        return;
      }
      const { x } = xOf(e);
      const { px, X } = geom();
      const b = cur();
      const i = drag.i;
      // ◆は拍頭どうしを結ぶ直線からの差として持つ
      const changed = drag.kind === 'at' ? set('at', i, (x - X(i)) / px) : set('mid', i, (x - X(i + 0.5)) / px - (b.at[i] + b.at[(i + 1) % n]) / 2);
      if (!changed) return;
      drag.moved = true;
      draw();
    });
    const end = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      draw();
      if (moved) onEdit();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => {
      const h = hit(e);
      if (!h || !set(h.kind, h.i, 0)) return;
      draw();
      onEdit();
    });
    const foot = document.createElement('div');
    foot.className = 'beats-foot';
    const note = document.createElement('span');
    note.textContent = state.meter ? `${n}拍（${state.meter}）` : `${n}拍（ファイルを開くと曲の拍子に合わせる）`;
    const reset = document.createElement('button');
    reset.type = 'button';
    MH.setIcon(reset, 'reset', 'すべて0に戻す');
    // スイング（ハネ）: 音価（8分・16分）と裏の位置（%）。拍数ごとの配置に一緒に持つ
    const swing = document.createElement('div');
    swing.className = 'beats-swing';
    const swLabel = document.createElement('span');
    swLabel.textContent = 'スイング';
    const grid = document.createElement('select');
    for (const [val, text] of [[8, '8分'], [16, '16分']]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = text;
      grid.appendChild(o);
    }
    const rate = document.createElement('input');
    rate.type = 'range';
    rate.min = it.swingMin;
    rate.max = it.swingMax;
    rate.step = 0.1;
    const rateVal = document.createElement('span');
    rateVal.className = 'val';
    const swingText = (v) => (v <= it.swingMin ? 'イーブン' : `${v}%${Math.abs(v - 66.7) < 0.05 ? '（三連）' : v === 75 ? '（付点）' : ''}`);
    const syncSwing = () => {
      const b = cur();
      grid.value = b.swingGrid;
      rate.value = b.swing;
      rateVal.textContent = swingText(b.swing);
    };
    grid.addEventListener('change', () => {
      put({ swingGrid: Number(grid.value) });
      draw();
      onEdit();
    });
    rate.addEventListener('input', () => {
      put({ swing: Math.round(Number(rate.value) * 10) / 10 });
      rateVal.textContent = swingText(cur().swing);
      draw();
      onEdit(true);
    });
    rate.addEventListener('change', () => onEdit());
    // ダブルクリックでイーブンに戻す（▲◆と同じ操作）
    rate.addEventListener('dblclick', () => {
      if (cur().swing === it.swingMin) return;
      put({ swing: it.swingMin });
      syncSwing();
      draw();
      onEdit();
    });
    swing.append(swLabel, grid, rate, rateVal);
    syncSwing();
    reset.addEventListener('click', () => {
      const next = Object.assign({}, values[it.key]);
      delete next[n];
      values[it.key] = next;
      syncSwing();
      draw();
      onEdit();
    });
    foot.append(note, reset);
    wrap.append(c, swing, foot);
    return wrap;
  }

  /** 開いている曲（加工対象のパート）のストロークの刻みが16分か。パターンの既定の ↓↑ の単位に使う（core/analyze.js の strumUse16。ファイルを開く前は8分） */
  let use16Cache = null;
  function songStrumUse16() {
    if (!state.src) return false;
    const t = targets();
    const key = JSON.stringify(t);
    if (!use16Cache || use16Cache.src !== state.src || use16Cache.key !== key) {
      const notes = MH.extractNotes(MH.splitPart(state.src, t).midi);
      use16Cache = { src: state.src, key, v: MH.strumUse16(MH.clusterOnsets(notes, Math.max(1, state.src.ppq / 48)), MH.buildTimeMaps(state.src)) };
    }
    return use16Cache.v;
  }

  /**
   * ギターの1小節のパターンのエディタ（16分のマスごと）。
   *  type 'strum'（強弱。ヒューマナイズの strumPattern と、楽器固有の詳細設定の強拍 strumStrongPattern）: 棒を上下ドラッグ（横になぞると続けて描く。ダブルクリックで0）。値は { 拍子: { acc } }
   *  type 'strumDir'（方向。楽器固有の詳細設定）: 矢印をクリックで ↓⇔↑（なぞると同じ向きにそろえる）。値は { 拍子: ['D'|'U', …] }。
   *    ストローク方向が「パターン指定」のときだけ操作でき、それ以外は薄く表示する（refresh で描き直す）
   *  type 'strumArtic'（ミュート奏法。楽器固有の詳細設定）: クリックで 通常 → × → PM の順に切り替える（なぞると同じ奏法にそろえる）。値は { 拍子: ['N'|'X'|'P', …] }
   *  type 'accentGrid'（ピアノ・ドラムの強弱。ヒューマナイズ）: 強弱と同じ操作で2小節ぶん。値は { 拍子: { acc } }。既定の型と「型を呼び出す」の強さは it.amount（値に "*": { scale } があればそちら）
   *  強弱（strum・accentGrid）は、上端の帯のドラッグでプラスのマス（強拍）を、下端の帯のドラッグでマイナスのマス（弱拍）を比率を保ってまとめて伸び縮みさせる
   * 離したときに onEdit を呼ぶ。拍子は開いている曲の主な拍子（ファイルを開く前は 4/4）。values[it.key] は書き換えずに新しいオブジェクトで置き換える
   */
  function strumEditor(it, values, onEdit) {
    const kind = it.type === 'strumDir' ? 'dir' : it.type === 'strumArtic' ? 'artic' : 'acc';
    const isDir = kind !== 'acc'; // マスごとの記号（方向・奏法）を選ぶエディタ
    const twoBars = it.type === 'accentGrid';
    const meter = state.meter || '4/4';
    const grid = MH.strumGrid(meter);
    const wrap = document.createElement('div');
    wrap.className = 'beats-edit strum-edit';
    const foot = document.createElement('div');
    foot.className = 'beats-foot';
    const note = document.createElement('span');
    foot.appendChild(note);
    if (!grid) {
      const fallback = { artic: 'パターン指定ではすべて通常にする', dir: 'パターン指定では表拍=ダウン・裏拍=アップの交互にする',acc: twoBars ? '拍頭を強く、16分を弱くする' : '小節頭・拍頭を強くする既定の強弱を使う' }[kind];
      note.textContent = `この拍子（${meter}）はパターンを指定できません（${fallback}）`;
      wrap.appendChild(foot);
      return wrap;
    }
    const TOP = 16; // 拍番号の下端
    const BAND = 10; // 強弱をまとめて伸び縮みさせる帯（棒の上端・下端の外側）の高さ
    const ACC_H = 24; // 強弱の最大（it.max）の棒の高さ
    const ACC_Y = TOP + BAND + ACC_H; // 強弱の0の高さ
    const DIR_TOP = 22; // 方向の矢印の上端
    const H = isDir ? 48 : ACC_Y + ACC_H + BAND + 2;
    const PAD = 12;
    const c = document.createElement('canvas');
    c.height = H;
    const g = c.getContext('2d');
    const n = grid.slots * (twoBars ? 2 : 1);
    const use16 = songStrumUse16();
    /** マスごとの値（強弱の数値、方向の 'D'/'U'、奏法の 'N'/'X'/'P'） */
    const cur = () =>
      twoBars
        ? MH.accentGridOf(values[it.key], meter, it.amount)
        : kind === 'artic' ? MH.strumArticOf(values[it.key], meter) : isDir ? MH.strumDirOf(values[it.key], meter, use16) : MH.strumPatternOf(values[it.key], meter).acc;
    /** 既定の型 */
    const star = () => (values[it.key] && values[it.key]['*'] ? { '*': values[it.key]['*'] } : {}); // 既定の型の強さだけ
    const base = () =>
      twoBars
        ? MH.accentGridOf(star(), meter, it.amount)
        : kind === 'artic'
        ? MH.strumArticOf({}, meter)
        : isDir
          ? MH.strumDirOf({}, meter, use16)
          : MH.strumPatternOf(star(), meter).acc;
    const active = () => (kind === 'dir' ? values.strumMode === 'pattern' : kind === 'artic' ? values.articMode === 'pattern' : true);
    const ARTIC_NEXT = { N: 'X', X: 'P', P: 'N' };
    const ARTIC_LABEL = { N: '・', X: '×', P: 'PM' };
    const geom = () => {
      const W = c.width;
      const sw = (W - PAD * 2) / n;
      return { W, sw, X: (s) => PAD + s * sw };
    };
    let drag = null; // { slot, dir?, moved }。帯のドラッグは { bulk: 1|-1, orig, idx, peak, y0, k, moved }
    let hoverBand = 0; // カーソルが乗っている帯（1=上端・強拍、-1=下端・弱拍、0=無し）
    const bandOf = (y) => (isDir ? 0 : y >= TOP && y < TOP + BAND ? 1 : y >= ACC_Y + ACC_H ? -1 : 0);
    /** 帯（sign: 1=上端・強拍、-1=下端・弱拍）を描く。ドラッグ中は倍率と最大の値を出す */
    const drawBand = (sign, W) => {
      const on = (drag && drag.bulk === sign) || (!drag && hoverBand === sign);
      const y = sign > 0 ? TOP : ACC_Y + ACC_H + 1;
      g.fillStyle = on ? '#2a2f3a' : '#16191f';
      g.fillRect(PAD, y, W - PAD * 2, BAND - 1);
      const label = sign > 0 ? '強拍' : '弱拍';
      const d = drag && drag.bulk === sign ? drag : null;
      g.fillStyle = on ? (sign > 0 ? '#a29bfe' : '#74b9ff') : '#4a4f5a';
      g.font = '9px sans-serif';
      g.textAlign = 'center';
      g.fillText(d ? `${label} ×${d.k.toFixed(2)}（最大 ${sign > 0 ? '+' : '−'}${Math.round(d.peak * d.k)}）` : `${label} ⇕`, W / 2, y + BAND - 2);
      g.textAlign = 'left';
      g.font = '11px sans-serif';
    };
    const draw = () => {
      const w = Math.round(c.clientWidth);
      if (!w) return; // 折りたたみ中（表示されたら ResizeObserver で描く）
      if (c.width !== w) c.width = w;
      const b = cur();
      const { W, sw, X } = geom();
      g.fillStyle = '#0d0f12';
      g.fillRect(0, 0, W, H);
      g.font = '11px sans-serif';
      g.textAlign = 'left';
      // マスの線（拍頭は濃く・拍番号付き）
      for (let s = 0; s <= n; s++) {
        const beatHead = s % grid.perBeat === 0;
        const barHead = twoBars && s % grid.slots === 0; // 2小節のときは小節線を明るく
        g.fillStyle = barHead ? '#5a6070' : beatHead ? '#3a3f4a' : '#20232a';
        g.fillRect(Math.round(X(s)), barHead ? 2 : TOP, 1, H - (barHead ? 2 : TOP) - 4);
        if (beatHead && s < n) {
          g.fillStyle = '#8a8f98';
          g.fillText(String((s % grid.slots) / grid.perBeat + 1), X(s) + 4, 11);
        }
      }
      if (!isDir) {
        g.fillStyle = '#3a3f4a';
        g.fillRect(PAD, ACC_Y, W - PAD * 2, 1);
        drawBand(1, W);
        drawBand(-1, W);
      }
      const px = isDir ? 0 : ACC_H / it.max;
      for (let s = 0; s < n; s++) {
        const hot = drag && drag.slot === s;
        if (!isDir) {
          // 強弱の棒（正＝上、負＝下）
          const v = b[s];
          const x = X(s) + sw * 0.2;
          const bw = Math.max(2, sw * 0.6);
          g.fillStyle = hot ? '#ffffff' : v >= 0 ? '#a29bfe' : '#74b9ff';
          g.fillRect(x, v >= 0 ? ACC_Y - v * px : ACC_Y + 1, bw, Math.max(1, Math.abs(v) * px));
          if (hot) {
            g.fillStyle = '#ffffff';
            const right = X(s) > W - 40;
            g.textAlign = right ? 'right' : 'left';
            g.fillText(`${v > 0 ? '+' : ''}${v}`, right ? x - 3 : x + bw + 3, ACC_Y - 6);
            g.textAlign = 'left';
          }
          continue;
        }
        if (kind === 'artic') {
          // 奏法の記号（通常＝点、ブラッシング＝×、パームミュート＝PM）
          const a = b[s];
          g.fillStyle = hot ? '#ffffff' : a === 'N' ? '#4a4f5a' : a === 'X' ? '#ff7675' : '#81ecec';
          g.font = (a === 'P' ? 'bold 10px' : 'bold 14px') + ' sans-serif';
          g.textAlign = 'center';
          g.fillText(ARTIC_LABEL[a], X(s) + sw / 2, DIR_TOP + 15);
          g.textAlign = 'left';
          g.font = '11px sans-serif';
          continue;
        }
        // 方向の矢印（↓＝ダウン、↑＝アップ）
        const cx = X(s) + sw / 2;
        const down = b[s] === 'D';
        const a = Math.min(6, sw * 0.35);
        g.fillStyle = !active() ? '#3a3f4a' : hot ? '#ffffff' : down ? '#fdcb6e' : '#55efc4';
        g.fillRect(Math.round(cx) - 1, DIR_TOP + (down ? 0 : 6), 2, 14);
        g.beginPath();
        if (down) {
          g.moveTo(cx, DIR_TOP + 22);
          g.lineTo(cx - a, DIR_TOP + 13);
          g.lineTo(cx + a, DIR_TOP + 13);
        } else {
          g.moveTo(cx, DIR_TOP);
          g.lineTo(cx - a, DIR_TOP + 9);
          g.lineTo(cx + a, DIR_TOP + 9);
        }
        g.fill();
      }
    };
    new ResizeObserver(draw).observe(c);
    const posOf = (e) => {
      const r = c.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * H };
    };
    const slotOf = (x) => {
      const { sw } = geom();
      return Math.max(0, Math.min(n - 1, Math.floor((x - PAD) / sw)));
    };
    /** この拍子のマスの値をまとめて置き換える */
    const put = (arr) => {
      const value = Object.assign({}, values[it.key], { [meter]: isDir ? arr : { acc: arr } });
      // 既定の型と同じになったら値を持たない（プリセットとの差分の判定を元に戻す）
      if (JSON.stringify(arr) === JSON.stringify(base())) delete value[meter];
      values[it.key] = value;
    };
    /** マス s の値を置き換える。値が変わったら true */
    const set = (s, v) => {
      if (!isDir) v = Math.round(Math.max(-it.max, Math.min(it.max, v)));
      const arr = cur().slice();
      if (arr[s] === v) return false;
      arr[s] = v;
      put(arr);
      return true;
    };
    const accOf = (y) => (ACC_Y - y) / (ACC_H / it.max);
    /**
     * 帯のドラッグ: 押したときのプラス（強拍）／マイナス（弱拍）のマスを、最大のマスがカーソルに付いてくる比率でまとめて伸び縮みさせる。
     * 押したときの値から毎回計算するので、0 まで縮めても戻せる。最大のマスが上限（it.max）に届いたらそれ以上は伸ばさない（比率を保つ）
     */
    const bulkTo = (y) => {
      const d = drag;
      const dv = (d.bulk > 0 ? d.y0 - y : y - d.y0) / (ACC_H / it.max);
      d.k = Math.max(0, Math.min(it.max / d.peak, (d.peak + dv) / d.peak));
      const arr = d.orig.slice();
      for (const s of d.idx) arr[s] = d.bulk * Math.round(Math.abs(d.orig[s]) * d.k);
      if (JSON.stringify(arr) === JSON.stringify(cur())) return false;
      put(arr);
      return true;
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !active()) return;
      const p = posOf(e);
      if (p.y < TOP - 4) return;
      const s = slotOf(p.x);
      const band = bandOf(p.y);
      if (band) {
        const orig = cur().slice();
        const idx = orig.map((v, i) => (v * band > 0 ? i : -1)).filter((i) => i >= 0);
        if (!idx.length) return; // 伸び縮みさせるマスが無い
        drag = { bulk: band, orig, idx, peak: Math.max(...idx.map((i) => Math.abs(orig[i]))), y0: p.y, k: 1, moved: false };
      } else if (isDir) {
        const dir = kind === 'artic' ? ARTIC_NEXT[cur()[s]] : cur()[s] === 'D' ? 'U' : 'D';
        drag = { slot: s, dir, moved: set(s, dir) };
      } else drag = { slot: s, moved: set(s, accOf(p.y)) };
      c.setPointerCapture(e.pointerId);
      draw();
    });
    c.addEventListener('pointermove', (e) => {
      const p = posOf(e);
      if (!drag) {
        const band = active() ? bandOf(p.y) : 0;
        c.style.cursor = p.y < TOP - 4 || !active() ? 'default' : isDir ? 'pointer' : band ? 'row-resize' : 'ns-resize';
        if (band !== hoverBand) {
          hoverBand = band;
          draw();
        }
        return;
      }
      if (drag.bulk) {
        drag.moved = bulkTo(p.y) || drag.moved;
        draw();
        return;
      }
      const s = slotOf(p.x);
      const changed = set(s, isDir ? drag.dir : accOf(p.y));
      if (!changed && s === drag.slot) return;
      drag.slot = s;
      drag.moved = drag.moved || changed;
      draw();
    });
    const end = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      draw();
      if (moved) onEdit();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (drag || !hoverBand) return;
      hoverBand = 0;
      draw();
    });
    if (!isDir) {
      c.addEventListener('dblclick', (e) => {
        const p = posOf(e);
        if (p.y < TOP - 4 || bandOf(p.y) || !set(slotOf(p.x), 0)) return;
        draw();
        onEdit();
      });
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    MH.setIcon(reset, 'reset', '既定の型に戻す');
    reset.addEventListener('click', () => {
      if (!values[it.key] || !values[it.key][meter]) return;
      const next = Object.assign({}, values[it.key]);
      delete next[meter];
      values[it.key] = next;
      draw();
      onEdit();
    });
    const syncNote = () => {
      const m = `${meter}・${grid.unit}×${grid.slots}${twoBars ? '×2小節' : ''}` + (state.meter ? '' : '（ファイルを開くと曲の拍子に合わせる）');
      note.textContent = active() ? m : `${m}　「パターン指定」のときに使う`;
    };
    syncNote();
    if (kind === 'acc') {
      // 型を呼び出す: 選んだ型をこの拍子のマスに埋める（強拍 +強さ、強拍でない8分より細かいマス −強さ/2）。
      // 強さは既定の型の強さ（ピアノ・ドラムは it.amount、ギターは 6。旧形式から変換した "*": { scale } があればそちら）。その拍子で使えない型・マスの範囲（ギターは1小節）より長い型は出さない
      const bars = twoBars ? 2 : 1;
      const amount = () => (twoBars ? MH.accentScale(values[it.key], it.amount) : MH.strumAccentScale(values[it.key]));
      const load = document.createElement('select');
      const head = document.createElement('option');
      head.value = '';
      head.textContent = '型を呼び出す…';
      load.appendChild(head);
      for (const pt of MH.ACCENT_PATTERNS) {
        if (!MH.accentGridFill(pt.id, meter, 1, bars)) continue;
        const o = document.createElement('option');
        o.value = pt.id;
        o.textContent = pt.label;
        load.appendChild(o);
      }
      load.addEventListener('change', () => {
        const acc = MH.accentGridFill(load.value, meter, amount(), bars);
        load.value = '';
        if (!acc) return;
        const value = Object.assign({}, values[it.key], { [meter]: { acc } });
        if (JSON.stringify(acc) === JSON.stringify(base())) delete value[meter];
        values[it.key] = value;
        draw();
        onEdit();
      });
      wrap.appendChild(load); // 棒の上（下の欄は拍子の説明と「既定の型に戻す」）
    }
    foot.appendChild(reset);
    wrap.append(c, foot);
    wrap.refresh = () => {
      syncNote();
      draw();
    };
    return wrap;
  }

  /**
   * 楽器固有の詳細設定のモーダルのドラムマップ欄は、表示中の楽器（開く前はタブ、開いた後はファイルの楽器）がドラムのときだけ
   */
  function syncDrumMapVisibility() {
    const drums = instShown() === 'drums';
    $('drumMap').classList.toggle('off', !drums);
    if (!instDialog) return; // モーダルを閉じている間は何もしない（初期化中の呼び出しでは drumMapUi がまだ無いため、ここで止める）
    drumMapUi.setActive(drums);
  }

  // 楽器固有の表示・操作（ツールバーの左手／右手・方向・奏法のボタン、色分け、凡例など）は、ファイルを開いてから（開く前の楽器は内部の初期値で、まだ決まっていない）
  const instReady = () => !!state.src && !sourceMode();
  /** ピアノの手の表示・操作は、ピアノかつヒューマナイズ編集のときだけ */
  const handActive = () => instReady() && instrument() === 'piano';
  /** ギターのストローク方向の表示・操作も、ギターかつヒューマナイズ編集のときだけ */
  const strumActive = () => instReady() && instrument() === 'guitar';
  /**
   * ノートごとの「印」（ピアノ: 左手／右手、ギター: ストロークの方向とミュート奏法）。どれも「ユーザーの修正 > 判定」で決まり、修正は再実行しても残る。
   * 楽器ごとに印の種類の配列。先頭の種類はクリックで反転する。値（'R' 等）は楽器の中で種類をまたいで重ならない。
   * field: ノートの確定値、auto: 判定の値、values: 値（先頭の2つをクリックで反転）、keys: キー → 値、group: ノートのまとまり（同じ値のキーを持つノートをまとめて修正する）、
   * buttons: ツールバーのボタンの id → 値、titles: 値 → 名前
   */
  const MARKS = {
    piano: [
      { field: 'hand', auto: 'handAuto', values: ['R', 'L'], keys: new Map([['r', 'R'], ['l', 'L']]), overrides: () => state.handOverrides, buttons: { toLeft: 'L', toRight: 'R' }, labels: { R: 'R', L: 'L' }, icons: { R: 'handRight', L: 'handLeft' }, titles: { R: '右手', L: '左手' } },
    ],
    guitar: [
      { field: 'strumDir', auto: 'strumAuto', values: ['D', 'U'], keys: new Map([['d', 'D'], ['u', 'U']]), overrides: () => state.strumOverrides, group: 'strumId', buttons: { toRight: 'D', toLeft: 'U' }, labels: { D: '↓', U: '↑' }, titles: { D: 'ダウン', U: 'アップ' } },
      {
        field: 'artic',
        auto: 'articAuto',
        values: ['N', 'X', 'P'],
        keys: new Map([['n', 'N'], ['x', 'X'], ['p', 'P']]),
        overrides: () => state.articOverrides,
        group: 'articId',
        buttons: { toNormal: 'N', toBrush: 'X', toPalm: 'P' },
        labels: { N: 'N', X: '×', P: 'PM' },
        titles: { N: '通常（ミュートなし）', X: 'ブラッシング', P: 'パームミュート' },
      },
    ],
  };
  /** 今の楽器・モードで使う印の種類（無ければ空） */
  const marksOf = () => (handActive() || strumActive() ? MARKS[instrument()] : []);
  /** 値（'R' 等）の印の種類 */
  const markFor = (value) => marksOf().find((m) => m.values.includes(value));
  /** キー（小文字）の値 */
  const markKey = (k) => {
    for (const m of marksOf()) if (m.keys.has(k)) return m.keys.get(k);
    return null;
  };
  /** 先頭の印（クリックで反転する種類）の付いたノートか（ギターの単音は方向で処理が変わらないので方向の印が無い） */
  const marked = (n) => {
    const m = marksOf()[0];
    return !!m && !!n[m.field];
  };
  /** フレーズの区切りの表示・操作は、ピアノ・ギターかつヒューマナイズ系のモードのときだけ */
  const phraseActive = () => instReady() && (instrument() === 'piano' || instrument() === 'guitar');
  /** ドラムマップの色分けも、ドラムかつヒューマナイズ系のモードのときだけ（ドラムマップ欄と同じ） */
  const drumActive = () => instReady() && instrument() === 'drums';
  /** 鍵盤列のドラムマップ（パーツの色、カーソルを当てたときのパーツ名）は MIDI編集でも出す（ノートのパーツ別の色分けは drumActive のまま） */
  const drumKeysActive = () => !!state.src && instrument() === 'drums';
  const COLOR_MODES = {
    piano: [
      ['hand', '左手／右手'],
      ['vel', 'ベロシティ'],
    ],
    guitar: [
      ['strum', '方向 ↓↑'], // ツールバーに収まるよう短く（ギターはボタンが多い）
      ['vel', 'ベロシティ'],
    ],
    drums: [
      ['part', 'パーツ別'],
      ['vel', 'ベロシティ'],
    ],
  };
  /** ピアノロールのノートの色分け。手・パーツの無い楽器・モードではベロシティ */
  const colorMode = () => (marksOf().length || drumActive() ? state.colorModes[instrument()] : 'vel');

  function syncHandUi() {
    const marks = marksOf();
    $('handTools').classList.toggle('hidden', !marks.length);
    $('articTools').classList.toggle('hidden', marks.length < 2);
    // L / R（ピアノ）と ↓ / ↑（ギター）は同じボタンを使い、楽器に合わせて表示を変える。並びは buttons の順（ピアノは鍵盤と同じ左手→右手）
    if (marks.length) {
      const [first, second] = Object.keys(marks[0].buttons).map($);
      first.after(second);
    }
    for (const m of marks) {
      for (const [id, value] of Object.entries(m.buttons)) {
        const b = $(id);
        const key = [...m.keys].find(([, v]) => v === value)[0].toUpperCase();
        const name = m.titles[value];
        // ピアノはアイコン、ギターは文字（↓ / ↑ など）
        if (m.icons?.[value]) MH.setIcon(b, m.icons[value]);
        else {
          b.classList.remove('ic-btn');
          b.textContent = m.labels[value];
        }
        b.setAttribute('aria-label', name);
        b.title = `${name}（${key}）`;
      }
    }
    syncPaintButtons();
    for (const b of handActions.querySelectorAll('button')) b.disabled = !handActive();
    for (const b of strumActions.querySelectorAll('button')) b.disabled = !strumActive();
    for (const b of phraseActions.querySelectorAll('button')) b.disabled = !phraseActive();
    $('colorTools').classList.toggle('hidden', !(marks.length || drumActive()));
    if (COLOR_MODES[instrument()]) {
      $('colorMode').replaceChildren(...COLOR_MODES[instrument()].map(([v, text]) => new Option(text, v)));
      $('colorMode').value = state.colorModes[instrument()];
    }
    const cm = colorMode();
    document.querySelectorAll('.legend-hand').forEach((el) => el.classList.toggle('hidden', cm !== 'hand'));
    document.querySelectorAll('.legend-strum').forEach((el) => el.classList.toggle('hidden', cm !== 'strum'));
    document.querySelectorAll('.legend-part').forEach((el) => el.classList.toggle('hidden', cm !== 'part'));
    document.querySelectorAll('.legend-vel').forEach((el) => el.classList.toggle('hidden', cm !== 'vel'));
  }

  /** 楽器の既定のプリセット（組み込みの並び順の先頭。選択欄は拍子で並べ替えるため、その先頭は使わない） */
  const defaultPresetKey = () => Object.keys(MH.PRESETS[instrument()])[0];

  /** @param {string} [key] 適用するプリセット（省略時はその楽器の既定） */
  function onInstrumentChange(key) {
    stopPlay();
    state.paintMark = null; // 塗る印の値は楽器ごとに違うため、塗りをやめる（ボタンの表示は syncHandUi で戻す）
    syncDrumMapVisibility();
    syncHandUi();
    if (state.src) syncTargets(); // 「もう片方の手のパート」はピアノのときだけ有効
    // 前の楽器のプリセット（同じキーが別の楽器にもありうる）を引き継がない
    presetKey = null;
    presetDirty = false;
    fillPresetSelect();
    applyPreset(key || defaultPresetKey());
  }

  guardSelect('preset', true, () => applyPreset($('preset').value));

  $('exportPreset').addEventListener('click', async () => {
    const custom = state.customPresets[instrument()][presetKey];
    const input = await MH.modal.prompt({ title: 'プリセットを書き出す', label: 'プリセット名', value: custom ? custom.name : '自作プリセット', maxLength: 60, okText: '書き出し' });
    const name = (input || '').trim();
    if (!name) return;
    // 拍子は選択中のプリセットのものを引き継ぐ（無ければ拍子共通）
    const meter = presetByKey(presetKey)?.meter;
    const json = Object.assign({ version: MH.PRESET_VERSION, instrument: instrument(), name, source: 'manual' }, meter && { meter }, { params: presetPart(state.params) });
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    download(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), `preset_${instrument()}_${safeName}.json`);
  });
  $('overwritePreset').addEventListener('click', () => {
    const custom = state.customPresets[instrument()][presetKey];
    if (!custom || !presetDirty) return;
    custom.params = presetPart(state.params);
    presetDirty = false;
    fillPresetSelect();
  });
  $('saveAsPreset').addEventListener('click', async () => {
    const base = presetByKey(presetKey);
    const custom = state.customPresets[instrument()][presetKey];
    const input = await MH.modal.prompt({ title: '名前を付けて保存', label: 'プリセット名', value: custom ? custom.name : (base ? base.name + 'のコピー' : '自作プリセット'), maxLength: 60, okText: '保存' });
    const name = (input || '').trim().slice(0, 60);
    if (!name) return;
    // 拍子・手別統計は選択中のプリセットのものを引き継ぐ。同じ名前・同じ拍子の読込済みプリセットがあれば確認して置き換える
    const meter = base?.meter;
    const customs = state.customPresets[instrument()];
    let key = Object.keys(customs).find((k) => customs[k].name === name && customs[k].meter === meter);
    if (key && !(await MH.modal.confirm({ title: '上書きの確認', message: `「${name}」を上書きしますか？`, okText: '上書き', danger: true }))) return;
    if (!key) key = 'custom_' + Date.now();
    customs[key] = Object.assign({ instrument: instrument(), name, source: 'manual', params: presetPart(state.params) }, base?.handStats && { handStats: base.handStats }, meter && { meter });
    presetKey = key;
    presetDirty = false;
    fillPresetSelect();
  });
  // 削除したら最初の組み込みプリセットに切り替える（未反映の変更などが消えるときは確認する）
  $('deletePreset').addEventListener('click', async () => {
    const customs = state.customPresets[instrument()];
    const custom = customs[presetKey];
    if (!custom) return;
    if (!(await MH.modal.confirm({ title: '削除の確認', message: `「${custom.name}」を削除しますか？`, okText: '削除', danger: true }))) return;
    if (!(await confirmDiscard(true))) return;
    delete customs[presetKey];
    applyPreset(defaultPresetKey());
    remember();
  });
  $('importPreset').addEventListener('click', () => $('presetFile').click());
  $('presetFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 1024 * 1024) throw new Error('ファイルが大きすぎます（上限1MB）');
      const p = MH.parsePresetJson(await f.text());
      // 楽器はファイルを開くときに決めるので、開いているファイルと別の楽器のプリセットは登録だけする
      const otherInstrument = !!state.src && p.instrument !== instrument();
      if (!otherInstrument && !(await confirmDiscard(true))) return;
      // 同じ名前・同じ拍子の読込済みプリセットがあれば置き換える（組み込みのプリセットは置き換えない）
      const customs = state.customPresets[p.instrument];
      const key = Object.keys(customs).find((k) => customs[k].name === p.name && customs[k].meter === p.meter) || 'custom_' + Date.now();
      customs[key] = p;
      if (otherInstrument) {
        const name = instrumentName(p.instrument);
        MH.modal.alert({ title: 'プリセット読込', message: `「${p.name}」は${name}用のプリセットのため、登録だけしました。\n楽器を「${name}」にしてファイルを開くと選べます。` });
        return;
      }
      state.instrument = p.instrument;
      onInstrumentChange(key);
      remember();
    } catch (err) {
      showError('プリセットの読み込みに失敗しました: ' + err.message);
    }
  });

  // ---------- 共通設定 ----------
  const intensity = $('intensity');
  const showIntensity = () => ($('intensityVal').textContent = Math.round(intensity.value * 100) + '%');
  intensity.addEventListener('input', () => {
    showIntensity();
    markDirty();
  });
  intensity.addEventListener('change', autoRun); // 離したとき
  $('zoom').addEventListener('input', draw);
  $('showOriginal').addEventListener('change', draw);

  // 試聴の音量（書き出すMIDIには影響しないため、実行・プリセットの対象外。値はブラウザに保存）
  const VOLUME_KEY = 'mh.volumeDb';
  const volume = $('volume');
  function applyVolume() {
    const db = Number(volume.value);
    $('volumeVal').textContent = db <= MH.player.VOLUME_MIN_DB ? '-∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
    MH.player.setVolume(db);
  }
  // ダブルクリックで 0 dB に戻す
  volume.addEventListener('dblclick', () => {
    volume.value = '0';
    volume.dispatchEvent(new Event('input'));
  });
  volume.addEventListener('input', () => {
    applyVolume();
    try {
      localStorage.setItem(VOLUME_KEY, volume.value);
    } catch (_) {
      // localStorage が使えない環境でも音量は変えられる
    }
  });
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null && Number.isFinite(Number(saved))) volume.value = saved; // 範囲外は range が丸める
  } catch (_) {
    // 保存値を読めなければ既定値
  }
  applyVolume();

  $('runBtn').addEventListener('click', async () => {
    if (!state.src) return;
    if (sourceMode()) {
      stopPlay();
      runNormalize();
      return;
    }
    if (!(await confirmDiscard(false))) return;
    stopPlay();
    run();
  });

  // ---------- 実行・表示 ----------
  const newSeed = () => Math.floor(Math.random() * 0x7fffffff);

  /** 画面の現在値からヒューマナイズの設定を作る（以降の画面操作で書き換わらないよう複製する） */
  function collectOpts() {
    return {
      human: {
        instrument: instrument(),
        params: structuredClone(state.params),
        seed: newSeed(), // 実行のたびに別の揺らぎにする
        intensity: Number(intensity.value),
        drumMap: MH.cleanDrumMap(drumMapUi.map()),
        presetKey, // 区間に覚えておき、区間を選んだときに設定へ戻す（区間のレーンの名前にも出す）
        presetDirty,
      },
      targets: targets(),
    };
  }

  /** 分析の結果を捨てる（次の実行の前に分析し直す）。ユーザーの修正は残す */
  function resetAnalysis() {
    state.handAuto.clear();
    state.strumAuto.clear();
    state.articAuto.clear();
    state.phraseAuto = null;
    state.analyzed = false;
  }

  /**
   * 分析段（core/analyze.js）: 加工対象のパート（今の一次データ）を分析し、値の無いノートの手・ストローク方向・奏法と、区切り（修正も検出済みも無いとき）を覚える。
   * 分析済みなら何もしない。判定の設定は実行の設定（o.human.params）
   */
  function analyzeSource(o) {
    if (state.analyzed) return;
    const inst = o.human.instrument;
    if (inst === 'piano' || inst === 'guitar') {
      const known = {
        hands: { parts: state.handParts, overrides: state.handOverrides, fixed: state.handAuto },
        strums: { fixed: state.strumAuto, articFixed: state.articAuto },
        phrases: phraseStarts(),
      };
      const an = MH.analyzePart(MH.splitPart(state.src, o.targets).midi, inst, o.human.params, known);
      if (an.phrases) state.phraseAuto = an.phrases.slice();
      const fill = (dest, map) => map && map.forEach((v, k) => dest.has(k) || dest.set(k, v));
      fill(state.handAuto, an.hands);
      fill(state.strumAuto, an.strums);
      fill(state.articAuto, an.artics);
    }
    state.analyzed = true;
  }

  /**
   * ヒューマナイズし直す（MIDI編集モードでは何もしない。ヒューマナイズ編集へ切り替えたときに今の設定でヒューマナイズする）。
   * 編集層を作り直す。ノートの修正値（state.noteOffsets）は最後に足し直し、その履歴も残す（レーンを引き継がなければレーンの履歴は消える）。
   * 処理の順: 分析（analyzeSource。未分析のときだけ）→ ヒューマナイズ（MH.process。分析の結果とユーザーの修正を渡す）→ 編集層の作り直し
   * @param {boolean} [reuseApplied] true なら直近の実行と同じ設定で（手の修正だけを反映するとき。未反映のパラメータは使わない）
   * @param {boolean} [whole] 範囲選択によらず全体を処理し直す（一次データが変わったとき）
   * @param {boolean|{start:number, end:number}} [merge] true なら区間をすべて結合し、全体を1区間で処理し直す。
   *   範囲なら、その範囲を今の設定の1区間にする（範囲の区間の結合。範囲外は直近の結果のまま）
   * @param {boolean} [keepSeed] true なら区間の乱数を引き継ぐ（パラメータの変更による自動の実行。setLayers を参照）
   * @param {boolean} [carry] true ならレーン（CC・ピッチベンド）を直前の編集層から引き継ぐ（reuseApplied で、CC・ピッチベンドの出力が変わらない操作のとき。buildEdit を参照）
   * @returns {boolean} 成功したか
   */
  function run(reuseApplied, whole, merge, keepSeed, carry) {
    // 抑揚のレーンを混ぜる割合（exprReplace は早く戻っても次の run に残らないよう、最初に読んで戻す）
    const exprWeight = exprReplace ? 1 : 0.5;
    exprReplace = false;
    if (!state.src) return false;
    if (sourceMode()) {
      humanStash = null; // 預かった結果は古い設定のもの。戻ったときに処理し直す
      return true;
    }
    const o = reuseApplied && state.applied ? state.applied : collectOpts();
    const span = merge && merge !== true ? merge : null;
    const how = span ? 'layer' : reuseApplied || whole || merge ? null : rangeMode();
    const sel = how && !span ? sectionRange() : null; // 結合の範囲（span）は mergeSections で選択範囲に反映済み
    const range = span || (sel && sel.range);
    // 抑揚: 直前の結果に重ねて処理し直すときは、直前の自動の値と比べて、今の設定にした区間の抑揚のレーンを混ぜる
    const prevAuto = !reuseApplied && layerable() ? state.result.exprAuto : null;
    const exprBefore = state.exprEdits;
    let exprAfter = exprBefore;
    if (!reuseApplied) setLayers(o, range, merge === true ? 'merge' : how, keepSeed);
    try {
      analyzeSource(o);
      const hands = o.human.instrument === 'piano' ? { parts: state.handParts, overrides: state.handOverrides, fixed: state.handAuto } : undefined;
      const strums = o.human.instrument === 'guitar' ? { overrides: state.strumOverrides, fixed: state.strumAuto, articOverrides: state.articOverrides, articFixed: state.articAuto } : undefined;
      const prevEdit = state.edit;
      const phrases = phraseStarts();
      const humanize = () => MH.process(state.src, 'humanize', null, Object.assign({}, o.human, { hands, strums, phrases, expression: state.exprEdits, noteOffsets: state.noteOffsets }), o.targets);
      state.result = humanize();
      // 今の設定にした区間で自動の値（抑揚（自動）の山なり）が変わったら、その区間だけ今のレーンの値（描いた点、無ければ直前の自動の値）と平均する
      // （プリセットの切り替えは置き換え）。区間の外は今のレーンの値のまま。混ぜた結果は描いた点として持ち、それで処理し直す
      if (prevAuto) {
        const spans = MH.sectionSpans(o.human.layers).filter((s, i) => o.human.layers[i].params === o.human.params);
        if (spans.length && !MH.sameLaneIn(prevAuto, state.result.exprAuto, spans)) {
          exprAfter = state.exprEdits = MH.blendLanePoints(exprBefore || prevAuto, state.result.exprAuto, spans, exprWeight, MH.EXPRESSION_RANGE);
          state.result = humanize();
        }
      }
      state.humanSrc = state.src;
      syncSnapGrid();
      const carried = buildEdit(o.targets, how === 'layer' && prevEdit ? { from: prevEdit, range } : null, prevEdit, reuseApplied && carry);
      // 初めて区切りを検出したら、フレーズのレーンを開く（閉じた後は開き直さない）
      if (phraseAvailable() && !state.knownLanes.has(PHRASE)) {
        state.knownLanes.add(PHRASE);
        state.laneIds.push(PHRASE);
      }
      // 抑揚のレーンも、最初の実行で開く（閉じた後は開き直さない）
      if (!state.knownLanes.has(EXPR)) {
        state.knownLanes.add(EXPR);
        state.laneIds.push(EXPR);
      }
      syncLaneTools();
      if (!reuseApplied) {
        state.applied = o;
        state.paramsDirty = false;
        // 設定に表示する区間: 範囲で作った区間（結合したなら先頭の区間）。範囲なしなら同じ位置の区間のまま
        syncEditSection(range ? range.start : merge ? 0 : state.editSection);
      }
      pruneHistory(carried); // レーンを引き継いだら履歴も残す。作り直したなら、その履歴は使えない
      if (sel) state.range = Object.assign({}, sel.shown); // 区間の単位に広げた範囲を選択範囲にも反映する
      syncEdited();
      draw();
      if (exprAfter !== exprBefore) pushHistory({ type: 'expr', before: exprBefore, after: exprAfter }); // 混ぜた抑揚のレーンは元に戻せる（設定は戻らない）
      return true;
    } catch (e) {
      // 前の結果を書き出したり編集したりしないよう、結果と編集層を捨てる
      state.result = state.edit = state.geom = null;
      state.exprEdits = exprBefore;
      syncBars(); // 右端・右下のバーを隠す
      state.edited = false;
      pruneHistory(false); // ノートの修正値は残るので、その履歴も残す
      syncRunUi();
      showError('処理に失敗しました: ' + e.message);
      return false;
    }
  }

  /**
   * 実行に使う区間（pipeline.js の humanize の layers・splitSections を参照）を o に書き込む。
   * 範囲があれば直近の実行の区間を切り分け、範囲を今の設定の新しい区間にする（範囲外の区間は設定・シードを保つので結果も変わらない。楽器固有の詳細設定・ドラムマップも範囲外は前の値のまま）。
   * 範囲が無ければ、直近の区間に重ねられるとき区間の境目を残し、設定に表示している区間（state.editSection）だけを今の設定にする。
   * ほかの区間はそれぞれの設定のまま（楽器固有の詳細設定・ドラムマップは全区間で共通なので今の値にする）。シードはどの区間も新しくする。
   * 重ねられないとき・結合するときは全体の1区間。
   * どの場合も拍子の変わる位置には境目を置く（結合しても消えない。meterCuts を参照）
   * keepSeed なら乱数を新しくせず、今の設定にする区間は（範囲があれば範囲の先頭の）区間の乱数、ほかの区間はそれぞれの乱数のまま（重ねられるときだけ）。
   * @param {'layer'|'merge'|null} how rangeMode を参照。'merge' は区間の結合
   * @param {boolean} [keepSeed] run を参照
   */
  function setLayers(o, range, how, keepSeed) {
    const h = o.human;
    const prev = how !== 'merge' && layerable() ? state.applied.human.layers : [];
    keepSeed = keepSeed && prev.length > 0;
    if (keepSeed) h.seed = prev[sectionIndexAt(prev, range ? range.start : state.editSection)].seed;
    const section = (seed) => ({ seed, params: h.params, intensity: h.intensity, drumMap: h.drumMap, presetKey: h.presetKey, presetDirty: h.presetDirty });
    const isNew = (l) => l.seed === h.seed && l.params === h.params;
    if (how === 'layer') {
      h.layers = MH.splitAt(MH.splitSections(state.applied.human.layers, range, section(h.seed)), meterCuts());
      h.main = h.layers.findIndex(isNew); // 判定の設定・フレーズの表示は新しい区間のもの
      return;
    }
    if (prev.length > 1) {
      const target = sectionIndexAt(prev, state.editSection);
      const keep = (l) => Object.assign({}, l, { seed: keepSeed ? l.seed : newSeed(), params: structuredClone(Object.assign({}, l.params, INST_PARAMS[h.instrument])), drumMap: h.drumMap });
      h.layers = MH.splitAt(prev.map((l, i) => Object.assign(i === target ? section(h.seed) : keep(l), { range: l.range })), meterCuts());
      h.main = Math.max(0, h.layers.findIndex(isNew));
      return;
    }
    h.main = 0;
    h.layers = MH.splitAt([Object.assign(section(h.seed), { range: null })], meterCuts());
  }

  /** 位置 t（元のMIDI上の tick）を含む区間の添字 */
  const sectionIndexAt = MH.sectionIndexAt;

  /**
   * 設定に表示している区間を、位置 t を含む区間にする（区間の始まりに揃える）。区間の拍子が変わったら、プリセットの並び・拍のエディタを描き直す
   * 区間が1つ（またはまだ実行していない）なら曲の主な拍子
   */
  const sigsCache = new WeakMap(); // 一次データ → 拍子の変化の一覧
  function syncEditSection(t) {
    const layers = sectionAvailable() ? state.applied.human.layers : null;
    state.editSection = layers ? MH.sectionSpans(layers)[sectionIndexAt(layers, t)].start : 0;
    let meter = state.songMeter;
    if (layers && layers.length > 1) {
      if (!sigsCache.has(state.humanSrc)) sigsCache.set(state.humanSrc, MH.buildTimeMaps(state.humanSrc).sigs);
      const sigs = sigsCache.get(state.humanSrc);
      const s = sigs.filter((x) => x.tick <= state.editSection).pop() || sigs[0];
      meter = `${s.num}/${s.den}`;
    }
    if (meter === state.meter) return;
    state.meter = meter;
    fillPresetSelect();
    renderParams();
  }

  /**
   * 範囲の先頭の区間の設定（プリセット・パラメータ・強度）を設定欄に読み込む（範囲を選んだとき）。
   * 設定に表示している区間と同じなら何もしない。未反映の変更があれば、読み込むか確認する（読み込まなければ今の設定のまま）
   */
  let loadingSection = false; // 確認を待っている間
  let keptSection = null; // 「今の設定のまま」を選んだ区間 { layers, start }。処理し直す（layers が変わる）までは同じ区間で確認し直さない
  async function loadSectionAt(t) {
    // 楽器・対象パートが変わってまだ処理し直していない区間は、今の楽器の設定として読み込めない
    if (loadingSection || !sectionAvailable() || !layerable() || state.applied.human.layers.length < 2) return;
    const layers = state.applied.human.layers;
    const i = sectionIndexAt(layers, t);
    const start = MH.sectionSpans(layers)[i].start;
    if (start === state.editSection) return;
    if (state.paramsDirty && keptSection && keptSection.layers === layers && keptSection.start === start) return;
    loadingSection = true;
    try {
      if (
        state.paramsDirty &&
        !(await MH.modal.confirm({
          title: '区間の設定の読み込み',
          message: `未反映のパラメータ変更があります。\n区間 ${i + 1} の設定を読み込みますか？（読み込むと未反映の変更は破棄されます）`,
          okText: '読み込む',
          cancelText: '今の設定のまま',
        }))
      ) {
        keptSection = { layers, start };
        return;
      }
      // 確認を待つ間に処理し直した（区間が変わった）ときは読み込まない
      if (!sectionAvailable() || state.applied.human.layers !== layers) return;
      const l = layers[i];
      // 区間のプリセットが削除済みなら既定のプリセット。変更の有無（*）は今のプリセットの値と比べ直す（上書き保存で中身が変わることがある）
      presetKey = l.presetKey && presetByKey(l.presetKey) ? l.presetKey : defaultPresetKey();
      state.params = structuredClone(Object.assign({}, l.params, INST_PARAMS[instrument()]));
      presetDirty = false;
      syncPresetDirty();
      intensity.value = l.intensity ?? 1;
      showIntensity();
      const meter = state.meter;
      syncEditSection(t);
      // 拍子が変わったときは syncEditSection で描き直している
      if (meter === state.meter) {
        fillPresetSelect();
        renderParams();
      }
      remember();
      state.paramsDirty = false;
      keptSection = null; // 読み込んだので、次に設定を変えたらどの区間でも確認し直す
      syncRunUi();
      draw();
    } finally {
      loadingSection = false;
    }
  }

  /** 拍子の変わる位置（区間の消せない境目。曲の終わり＝全パートの最後の音の終わりより前だけ）。区間のレーンの描画でも使うので一次データごとに覚えておく */
  const meterCutsCache = new WeakMap();
  function meterCuts(src = state.src) {
    if (!meterCutsCache.has(src)) meterCutsCache.set(src, MH.meterChanges(MH.buildTimeMaps(src), MH.maxOf(MH.extractNotes(src), (n) => n.endTick)));
    return meterCutsCache.get(src);
  }

  /** 曲の終わり（加工前の最後のノートの終わり） */
  const songEnd = () => MH.maxOf(state.result.before, (n) => n.endTick);

  /**
   * 選択範囲を区間の単位（1拍）まで外側へ広げる。shown は選択範囲に反映する範囲（処理に成功してから反映する）。
   * 後ろで始まるノートが無いなら区間の終わりは Infinity（後ろにノートの無い区間を作らない。伸ばした音の途中までの範囲も含む）
   * @returns {{range:{start:number, end:number}, shown:{start:number, end:number}}}
   */
  function sectionRange() {
    const r = MH.beatRange(state.result.maps, state.range);
    return { range: { start: r.start, end: MH.sectionEnd(r.end, state.result.before) }, shown: r };
  }

  // ---------- MIDI編集モード（一次データの直接編集） ----------
  /** 加工対象パートの一次データをピアノロールに出す（レーンは表示だけ） */
  function showSource() {
    state.result = MH.sourceView(state.src, targets(), state.srcGrid);
    buildEdit(targets());
    syncSnapGrid();
    syncNormGridWarn();
    syncUndoUi();
    syncRunUi();
    draw();
  }

  /** MIDI編集モードへ: ヒューマナイズ編集の結果・編集層を預けて、一次データを表示する */
  function enterSource() {
    if (state.result && !state.result.source) humanStash = { result: state.result, edit: state.edit };
    showSource();
  }

  /**
   * ヒューマナイズ編集へ: 一次データが変わっていなければ預けた結果に戻し、変わっていれば（または結果が無ければ）今の設定で全体をヒューマナイズし直す。
   * レーンの手動編集が失われるときは確認する
   * @returns {Promise<boolean>} 切り替えたか（キャンセル・失敗なら false）
   */
  async function enterHumanize() {
    const stash = humanStash;
    humanStash = null;
    if (stash) {
      state.result = stash.result;
      state.edit = stash.edit;
      endDrag();
    }
    if (stash && state.humanSrc === state.src) {
      syncLaneTools();
      syncSnapGrid();
      draw();
      return true;
    }
    if (stash && !(await confirmDiscard(false, true, true))) {
      humanStash = stash;
      return false;
    }
    // ヒューマナイズ編集の履歴は古い一次データのキー・レーンを指すので捨てる（ノートの修正値は付け替えて残っている）
    undoStack = [];
    redoStack = [];
    return run(false, true);
  }

  /** 修正をノートのキーで覚えている Map（一次データを書き換えたら付け替える） */
  const keyedMaps = () => [state.handOverrides, state.strumOverrides, state.articOverrides, state.noteOffsets];

  /**
   * 一次データを書き換えて履歴に積む
   * @param {{midi:object, moves:[string, string][], phrases?:number[]|null, expr?:object[]|null, grid?:object}} next phrases: 新しいフレーズの区切りの修正、expr: 新しい抑揚のレーンの修正、grid: ノーマライズで判定した最小音価など（どれも省略時は変えない）
   */
  function commitSource(next) {
    if (!state.result || !state.result.source) return; // 消したノートのキーは一次データの表示から求める
    const kept = new Set(next.moves.map(([from]) => from));
    const drop = state.result.after.map((n) => n.key0).filter((k) => !kept.has(k));
    const phraseAfter = 'phrases' in next ? next.phrases : state.phraseEdits;
    const exprAfter = 'expr' in next ? next.expr : state.exprEdits;
    const gridAfter = 'grid' in next ? next.grid : state.srcGrid;
    const h = { before: state.src, after: next.midi, moves: next.moves, drop, dropped: [], phraseBefore: state.phraseEdits, phraseAfter, exprBefore: state.exprEdits, exprAfter, gridBefore: state.srcGrid, gridAfter };
    srcRedo = [];
    srcUndo.push(h);
    if (srcUndo.length > MAX_SRC_HISTORY) srcUndo.shift();
    applySource(h, true);
  }

  /** 履歴の1件を反映する（forward: true なら書き換え後、false なら書き換え前にする） */
  function applySource(h, forward) {
    endDrag();
    state.src = forward ? h.after : h.before;
    const moves = forward ? h.moves : MH.invertMoves(h.moves);
    if (forward) h.dropped = MH.rekeyMaps(keyedMaps(), moves, h.drop);
    else {
      MH.rekeyMaps(keyedMaps(), moves, []);
      MH.restoreDropped(keyedMaps(), h.dropped);
    }
    if (h.phraseBefore !== h.phraseAfter) state.phraseEdits = forward ? h.phraseAfter : h.phraseBefore;
    if (h.exprBefore !== h.exprAfter) state.exprEdits = forward ? h.exprAfter : h.exprBefore;
    state.srcGrid = forward ? h.gridAfter : h.gridBefore;
    // 選択は付け替える（消えたノートの選択は外す）
    const map = new Map(moves);
    state.selection = new Set([...state.selection].filter((k) => map.has(k)).map((k) => map.get(k)));
    // 一次データが変わったので、分析をやり直す（ヒューマナイズの結果が古いかは state.humanSrc と比べる）
    resetAnalysis();
    try {
      computeHandParts();
      drumMapUi.setNotes(MH.extractNotes(MH.splitPart(state.src, targets()).midi));
      showSource();
      if (MH.player.isPlaying()) startPlay(MH.player.position());
    } catch (e) {
      showError('表示の更新に失敗しました: ' + e.message);
    }
  }

  /** MIDI編集の元に戻す（back: true）・やり直し */
  function stepSource(back) {
    const from = back ? srcUndo : srcRedo;
    if (!from.length || drag || !state.edit) return;
    const h = from.pop();
    (back ? srcRedo : srcUndo).push(h);
    applySource(h, !back);
  }

  /**
   * 編集層のノート（加工対象パートの全ノート）で一次データを書き換える。失敗したら（すべて消したなど）表示を一次データに戻す
   * @returns {boolean} 書き換えたか
   */
  function commitSourceNotes(notes) {
    let next;
    try {
      next = MH.applySourceNotes(state.src, targets(), notes);
    } catch (e) {
      showError(e.message);
      showSource();
      return false;
    }
    commitSource(next);
    return true;
  }

  /** ノートを消す（MIDI編集モード） */
  function deleteNotes(notes) {
    if (!notes.length || !state.edit) return;
    const gone = new Set(notes);
    commitSourceNotes(state.edit.notes.filter((n) => !gone.has(n)));
  }

  /** ノーマライズを実行する（MIDI編集モード。範囲選択があれば範囲内だけ）。結果で一次データを書き換える */
  function runNormalize() {
    const range = rangeMode('source') ? Object.assign({}, state.range) : null;
    let res;
    try {
      res = MH.normalizeSource(state.src, targets(), { params: structuredClone(state.normParams), instrument: instrument() }, range);
    } catch (e) {
      showError('ノーマライズに失敗しました: ' + e.message);
      return;
    }
    commitSource({ midi: res.midi, moves: res.moves, phrases: MH.remapStarts(state.phraseEdits, res.shifts), expr: MH.remapPoints(state.exprEdits, res.shifts), grid: res.grid });
  }

  /**
   * 実行結果から編集層を作り直す
   * @param {{from:object, range:{start:number, end:number}}} [rangeFrom] 選択範囲に絞った実行のとき。範囲外のレーンの点（手動編集を含む）は直前の編集層から引き継ぐ
   * @param {object} [lockFrom] 直前の編集層。編集をロックしたレーンは、対象パートが同じならその内容のまま残す（選択範囲に関わらず）
   * @param {boolean} [carry] 直近の実行と同じ設定・乱数で処理し直し、CC・ピッチベンドの出力が変わらない（抑揚のレーンの修正。ベロシティにしか効かない）。
   *   手動編集したレーン（lockFrom.dirtyLanes）とロックしたレーンをその内容のまま残し、編集ありの状態も引き継ぐ（レーンの編集が失われないので、破棄の確認も要らない）
   * @returns {boolean} レーンを引き継いだか（carry で対象パートが同じとき）
   */
  function buildEdit(parts, rangeFrom, lockFrom, carry) {
    const r = state.result;
    const notes = r.after.map((n) => Object.assign({}, n));
    let lanes = MH.extractLanes(r.midi, parts);
    const dirtyLanes = new Set();
    let ccCarried = false; // 引き継いだレーンに手動編集が含まれる（処理し直しで失われうるので、編集ありとして扱う）
    if (rangeFrom) {
      // 範囲の終わりの点（後ろのレイヤーの値に戻す点）は新しい結果から取る
      const { from, range } = rangeFrom;
      const merged = {};
      let keptPoints = false;
      for (const id of new Set([...Object.keys(lanes), ...Object.keys(from.lanes)])) {
        const outside = (from.lanes[id] || []).filter((p) => p.tick < range.start || p.tick > range.end).map((p) => Object.assign({}, p));
        if (outside.length) keptPoints = true;
        const inside = (lanes[id] || []).filter((p) => p.tick >= range.start && p.tick <= range.end);
        merged[id] = outside.concat(inside).sort((a, b) => a.tick - b.tick);
        dirtyLanes.add(id);
      }
      lanes = merged;
      // 範囲外に点が残ったときだけ、手動編集を引き継いだとみなす（手動の点かどうかは区別できないので近似）
      ccCarried = keptPoints && !!(from.ccCarried || from.lanesEdited);
    }
    const sameParts = !!lockFrom && JSON.stringify(lockFrom.parts) === JSON.stringify(parts);
    let lanesEdited = false;
    const carried = !!carry && sameParts;
    if (carried) {
      for (const id of new Set([...lockFrom.dirtyLanes, ...state.locked])) {
        if (!(id in lockFrom.lanes)) continue; // レーンの点ではないもの（フレーズの区切り）
        lanes[id] = lockFrom.lanes[id].map((p) => Object.assign({}, p));
        dirtyLanes.add(id);
      }
      lanesEdited = lockFrom.lanesEdited;
      ccCarried = lockFrom.ccCarried;
    } else if (sameParts) {
      for (const id of state.locked) {
        if (!(id in lanes) && !(id in lockFrom.lanes)) continue; // レーンの点ではないもの（フレーズの区切り）
        lanes[id] = (lockFrom.lanes[id] || []).map((p) => Object.assign({}, p));
        dirtyLanes.add(id); // 書き出しでも直前の内容に差し替える
        // 残したレーンに手動編集が含まれうる（ロックを外して処理し直すと失われるので、編集ありとして扱う）
        if (lockFrom.dirtyLanes.has(id) && (lockFrom.lanesEdited || lockFrom.ccCarried)) ccCarried = true;
      }
    }
    // 抑揚のレーンは描いた点（無ければ自動の値）を出す。ヒューマナイズへの入力なので、範囲・ロックによらず state.exprEdits から作る
    const exprLanes = { [EXPR]: copyPoints(state.exprEdits || r.exprAuto) };
    state.edit = { parts, notes, lanes, exprLanes, notesEdited: false, lanesEdited, ccCarried, dirtyLanes, endTick: MH.maxOf(notes, (n) => n.endTick) };
    endDrag(); // 作り直す前の編集層に対するドラッグは打ち切る
    // CC・ピッチベンドのレーンは自動では開かない（「＋」・設定・左端の列の右クリックで選ぶ）
    syncLaneTools();
    return carried;
  }

  function syncLaneTools() {
    const lanes = state.edit ? state.edit.lanes : {};
    laneTools.update(
      state.laneIds,
      Object.keys(lanes)
        .filter((id) => lanes[id].length)
        .concat(phraseAvailable() ? [PHRASE] : [])
        .concat(exprAvailable() ? [EXPR] : []) // 区間のレーンは常に表示するので選べるレーンに入れない
    );
  }

  /** 加工後の試聴用のCC（編集後のレーンから） */
  function editedCCs() {
    const out = [];
    for (const [id, points] of Object.entries(state.edit.lanes)) {
      if (id === 'pb') continue;
      for (const p of MH.expandRamps(points, MH.rampGap(state.result.maps.ppq))) out.push({ tick: p.tick, cc: Number(id.slice(2)), value: p.value });
    }
    return out.sort((a, b) => a.tick - b.tick);
  }

  function draw() {
    cancelAnimationFrame(drawId);
    drawId = 0;
    const r = state.result;
    if (!r) return;
    const ed = state.edit;
    const wrap = $('rollWrap');
    const drawOnce = () =>
      MH.drawRoll($('roll'), {
        before: r.before,
        after: ed.notes,
        // 区間のレーンは、ベロシティと同じく常にその下に出す（ヒューマナイズ編集で結果があるとき。閉じられない）
        lanes: (sectionAvailable() ? [sectionLane()] : []).concat(
          state.laneIds.filter((id) => (id !== PHRASE || phraseAvailable()) && (id !== EXPR || exprAvailable())).map((id) => (id === PHRASE ? phraseLane() : id === EXPR ? exprLane() : { id, label: MH.lanes.shortLabel(id), role: MH.lanes.roleName(id), color: MH.lanes.color(id), range: MH.lanes.range(id), points: ed.lanes[id] || [] }))
        ),
        minEndTick: ed.endTick,
        maps: r.maps,
        zoom: Number($('zoom').value),
        showOriginal: $('showOriginal').checked,
        colorMode: colorMode(),
        articMarks: marksOf().length > 1,
        drumPart: drumKeysActive() ? MH.drumAssignment(drumMapUi.map()) : null,
        selected: state.paintKeys || state.selection,
        keyOf: selKey,
        pointSel: state.pointSel,
        range: state.range && Object.assign({ loop: loopOn() }, state.range),
        headers: { corner: $('rollCorner'), ruler: $('rollRuler'), keys: $('rollKeys') },
        viewW: wrap.clientWidth,
        viewH: wrap.clientHeight,
        noteViewH: state.noteViewH,
        pitchScroll: state.pitchScroll,
        rowH: state.rowH,
        folded: state.folded,
        locked: state.locked,
        laneH: state.laneH,
      });
    const viewW = wrap.clientWidth;
    const viewH = wrap.clientHeight;
    state.geom = drawOnce();
    // 描いた結果でスクロールバーが現れる・消えるなどして枠の内側の大きさが変わったら合わせ直す（高さは枠に合わせる場合のみ）
    if (wrap.clientWidth !== viewW || (state.noteViewH == null && wrap.clientHeight !== viewH)) state.geom = drawOnce();
    state.pitchScroll = state.geom.pitchScroll;
    // 枠に収まらず縮めた高さに合わせる（大きいまま残すと、境目を上へドラッグしても動かない区間ができる）
    if (state.noteViewH != null && state.noteViewH > state.geom.noteH) state.noteViewH = state.geom.noteH;
    placeHead(headTick());
    showHandInfo();
    syncBars();
  }

  // ドラッグ中は1フレームに1回だけ描き直す
  let drawId = 0;
  function requestDraw() {
    if (!drawId) drawId = requestAnimationFrame(draw);
  }

  // ---------- ヒューマナイズの区間 ----------
  // 区間は直近の実行のレイヤー（state.applied.human.layers）。位置は元のMIDI上の位置（ピアノロールの横軸と同じ）
  const SECTION = MH.lanes.SECTION;

  /** 区間のレーンを出せるか（ヒューマナイズ編集で結果があるとき） */
  function sectionAvailable() {
    return !!(state.result && !sourceMode() && state.applied && state.applied.human.layers);
  }

  /** 区間の帯の名前（番号・プリセット名・強度。設定に表示している区間には ▶ を付ける） */
  function sectionLabel(l, i, start) {
    const p = l.presetKey && presetByKey(l.presetKey);
    const name = p ? `  ${p.name}${l.presetDirty ? '*' : ''}` : '';
    const current = start === state.editSection && state.applied.human.layers.length > 1;
    return `${current ? '▶' : ''}${i + 1}${name}  ${Math.round((l.intensity ?? 1) * 100)}%`;
  }

  /** 描画に渡す区間のレーン（fixed は拍子の変わる位置の消せない境目） */
  function sectionLane() {
    const layers = state.applied.human.layers;
    const cuts = new Set(meterCuts(state.humanSrc));
    const spans = MH.sectionSpans(layers).map((sp, i) => Object.assign(sp, { label: sectionLabel(layers[i], i, sp.start), fixed: cuts.has(sp.start) }));
    // 結合で消せる境目（拍子の変わる位置以外）があるときだけ結合のボタンを出す
    const mergeable = spans.some((sp, i) => i && !sp.fixed);
    return { id: SECTION, label: MH.lanes.shortLabel(SECTION), role: layers.length > 1 ? `${layers.length} 区間` : '', color: MH.lanes.color(SECTION), range: [0, 1], points: [], section: { spans, mergeable } };
  }

  /** キャンバスのxにある区間の範囲（最後の区間は曲の終わりの拍まで。左右の外なら端の区間） */
  function sectionAt(px) {
    const t = state.geom.tickAt(px);
    const spans = MH.sectionSpans(state.applied.human.layers);
    const sp = spans.find((s) => t < s.end) || spans[spans.length - 1];
    const end = sp.end === Infinity ? MH.beatRange(state.result.maps, { start: sp.start, end: Math.max(songEnd(), sp.start + 1) }).end : sp.end;
    return { start: sp.start, end };
  }

  /**
   * 区間のレーンのクリック・ドラッグ: 押した区間を範囲選択にし、ドラッグでなぞった区間まで広げる。
   * Shift+クリックは、今の範囲選択と押した区間をまとめた範囲にする（間の区間も含む）
   */
  function startSectionDrag(e, p) {
    const sp = sectionAt(p.x);
    const cur = e.shiftKey && state.range && state.range.end > state.range.start ? state.range : null;
    const anchor = cur ? { start: Math.min(cur.start, sp.start), end: Math.max(cur.end, sp.end) } : sp;
    drag = Object.assign(p, { kind: 'sections', moved: false, edit: state.edit, anchor });
    state.range = Object.assign({}, anchor);
    draw();
  }

  /**
   * 範囲選択の中で結合する区間の範囲: 範囲の内側にある、消せる境目（拍子の変わる位置以外）の両側の区間をまとめた範囲。
   * 消せる境目が無ければ null
   */
  function mergeSpan(range) {
    return MH.mergeSpan(sectionLane().section.spans, range);
  }

  /**
   * 区間を結合し、今の設定で処理し直す。範囲選択があれば範囲の中の境目だけを消す（範囲外の区間は直近の結果のまま）。
   * 範囲選択が無ければすべて結合する。どちらも拍子の変わる位置の境目は残る
   */
  let merging = false; // 確認を待っている間（二重に押されたとき）
  async function mergeSections() {
    if (merging || !sectionAvailable() || !sectionLane().section.mergeable) return;
    const ranged = !!state.range && state.range.end > state.range.start && layerable();
    const span = ranged ? mergeSpan(state.range) : null;
    if (ranged && !span) return MH.modal.alert({ title: '区間の結合', message: '選択範囲の中に結合できる区間の境目がありません（拍子の変わる位置の境目は消せません）' });
    merging = true;
    const before = state.range;
    // 結合する区間を範囲選択にして見せる（最後の区間は曲の終わりの拍まで）
    if (span) state.range = { start: span.start, end: span.end === Infinity ? MH.beatRange(state.result.maps, { start: span.start, end: Math.max(songEnd(), span.start + 1) }).end : span.end };
    draw();
    try {
      if (!(await confirmDiscard(false, true, !span))) {
        state.range = before;
        draw();
        return;
      }
      stopPlay();
      if (!run(false, false, span || true)) state.range = before; // 失敗したら範囲選択を元に戻す
    } finally {
      merging = false;
    }
  }

  // ---------- フレーズの区切りの修正 ----------
  // 区切りは元のMIDI上の位置（正規化前の tick）で持つ。ピアノロールの横軸（加工前のノートの位置）と同じなので、そのまま描ける
  const PHRASE = MH.lanes.PHRASE;
  const PHRASE_PARAM_KEYS = ['phraseBars', 'phraseGapBeats'];
  let phraseBusy = false; // 区切りの反映（確認・処理し直し）の途中

  /** 再判定・再検出を絞る範囲（ヒューマナイズと同じ選択範囲。無ければ null で曲全体）。ノート・区切りは元のMIDI上の位置で比べる */
  const judgeRange = () => (state.range && state.range.end > state.range.start ? Object.assign({}, state.range) : null);
  const inJudgeRange = (r, t) => t >= r.start && t < r.end;

  /** 処理に使う区切り（修正 > 検出済み。どちらも無ければ null で、処理のときに検出する） */
  function phraseStarts() {
    return state.phraseEdits || state.phraseAuto;
  }
  /** 直近の結果にフレーズの区切りがあるか（ピアノ・ギターのヒューマナイズ編集） */
  function phraseAvailable() {
    return !!(state.result && !sourceMode() && ['piano', 'guitar'].includes(instrument()) && phraseStarts());
  }

  /** 描画に渡すフレーズのレーン（結果に区切りがあるときだけ） */
  function phraseLane() {
    const starts = state.phraseDraft || phraseStarts() || [];
    const role = state.phraseEdits ? '修正あり' : '自動';
    return { id: PHRASE, label: MH.lanes.shortLabel(PHRASE), role, color: MH.lanes.color(PHRASE), range: [0, 1], points: [], phrase: { starts } };
  }

  /** 重複を除いて並べた区切り */
  const normStarts = (starts) => [...new Set(starts.map((t) => Math.max(0, Math.round(t))))].sort((a, b) => a - b);

  /**
   * 区切りの修正を確認のうえ反映する（直近の実行と同じ設定で処理し直す）
   * @param {number[]|null} edits 新しい修正（null なら自動検出のまま）
   * @param {number[]|null} [expect] 呼んだ時点の修正（確認を待つ間に変わっていたら反映しない）
   * @returns {Promise<boolean>} 反映したか
   */
  async function setPhrases(edits, expect = state.phraseEdits) {
    phraseBusy = true;
    try {
      if (!(await confirmDiscard(false, true, true)) || state.phraseEdits !== expect) return false;
      const saved = state.phraseEdits;
      state.phraseEdits = edits;
      stopPlay();
      if (run(true)) return true;
      state.phraseEdits = saved;
      return false;
    } finally {
      phraseBusy = false;
      draw();
    }
  }

  /** 区切りを変えて履歴に積む（変わらなければ何もしない）。ドラッグの途中の表示（phraseDraft）は済むまで残す */
  async function commitPhrases(next) {
    try {
      const before = state.phraseEdits;
      next = next && normStarts(next);
      if (JSON.stringify(next || state.phraseAuto) === JSON.stringify(phraseStarts())) return;
      if (await setPhrases(next, before)) pushHistory({ type: 'phrase', before, after: next });
    } finally {
      state.phraseDraft = null;
      draw();
    }
  }

  // 戻すたびに処理し直す履歴の種類（フレーズの区切り・抑揚のレーン）
  const REPROCESS_TYPES = new Set(['phrase', 'expr']);

  /**
   * 元に戻す・やり直しで、フレーズの区切り・抑揚のレーンの履歴を1つ反映する（反映できたら履歴を移す）。
   * 処理し直すと履歴の配列が作り直される（pruneHistory）ので、移すときに改めて参照する
   * @param {boolean} back true なら元に戻す、false ならやり直し
   */
  async function stepReprocess(back) {
    const h = (back ? undoStack : redoStack).slice(-1)[0];
    const set = h.type === 'expr' ? setExpr : setPhrases;
    if (!(await set(back ? h.before : h.after))) return;
    const from = back ? undoStack : redoStack;
    const i = from.lastIndexOf(h);
    if (i >= 0) from.splice(i, 1);
    (back ? redoStack : undoStack).push(h);
    syncEdited();
    syncUndoUi();
  }

  // ---------- 抑揚のレーン ----------
  // ヒューマナイズへの入力。描いた点は元のMIDI上の位置で持ち、抑揚（自動）の山なりの代わりにベロシティへ足す（humanizers/pipeline.js の applyExpression）。
  // 描くまでは自動（直近の結果の exprAuto）を表示し、最初に描いた時点の表示（自動の値を含む）がそのまま描いた点になる
  const EXPR = MH.lanes.EXPR;

  /** 抑揚のレーンを出せるか（ヒューマナイズ編集で結果があるとき） */
  function exprAvailable() {
    return !!(state.result && !sourceMode() && state.edit && state.edit.exprLanes);
  }

  /** 描画に渡す抑揚のレーン */
  function exprLane() {
    const role = state.exprEdits ? '修正あり' : '自動';
    return { id: EXPR, label: MH.lanes.shortLabel(EXPR), role, color: MH.lanes.color(EXPR), range: MH.lanes.range(EXPR), points: state.edit.exprLanes[EXPR] };
  }

  /**
   * 抑揚のレーンの修正を確認のうえ反映する（直近の実行と同じ設定で処理し直す）
   * @param {object[]|null} edits 新しい点（null なら自動に戻す）
   * @param {object[]|null} [expect] 呼んだ時点の修正（確認を待つ間に変わっていたら反映しない）
   * @returns {Promise<boolean>} 反映したか
   */
  async function setExpr(edits, expect = state.exprEdits) {
    phraseBusy = true;
    try {
      if (state.exprEdits !== expect) return false; // 抑揚はベロシティにしか効かないので、レーン（CC・ピッチベンド）の編集は引き継ぐ（buildEdit の carry）。確認は要らない
      const saved = state.exprEdits;
      state.exprEdits = edits;
      const at = MH.player.isPlaying() ? MH.player.position() : null; // 再生中なら、処理し直した後に同じ位置から再生し直す
      stopPlay();
      if (run(true, false, false, false, true)) {
        if (at != null) startPlay(at);
        return true;
      }
      state.exprEdits = saved;
      return false;
    } finally {
      phraseBusy = false;
      draw();
    }
  }

  /** 抑揚のレーンで描いた内容を確定する（変わっていなければ何もしない。反映しなかったら表示を戻す） */
  async function commitExpr(before) {
    const next = copyPoints(state.edit.exprLanes[EXPR]);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    const prev = state.exprEdits;
    if (await setExpr(next, prev)) pushHistory({ type: 'expr', before: prev, after: next });
    else if (state.edit && state.result) {
      state.edit.exprLanes[EXPR] = copyPoints(state.exprEdits || state.result.exprAuto);
      draw();
    }
  }

  /** 抑揚のレーンを自動に戻す（元に戻す対象） */
  async function resetExpr() {
    const prev = state.exprEdits;
    if (!prev || phraseBusy) return;
    if (await setExpr(null, prev)) pushHistory({ type: 'expr', before: prev, after: null });
  }

  // 直前に追加した区切りと時刻（追加したばかりの区切りを、続くダブルクリックで消さないように）
  let addedPhrase = { tick: null, at: 0 };

  /**
   * 区切りを置ける位置。先頭の区切り（最初の音の位置。それより前には音が無いので、曲の最初のフレーズは必ずそこから始まる）より後ろに限る
   * @param {number[]} starts 今の区切り
   */
  const phraseTickAt = (starts, px, shift) => Math.max(starts.length ? starts[0] + 1 : 0, placeTick(state.geom.tickAt(px), shift));

  /**
   * フレーズのレーンでの操作を始める。区切り線を掴めば移動、何も無い所なら区切りを追加（続けてドラッグで位置を決める）。
   * 先頭の区切りは動かせない・消せない
   * @param {boolean} erase 区切り線を消す（消しゴム）
   */
  function startPhraseDrag(p, shift, erase) {
    if (!phraseAvailable() || phraseBusy) return;
    const starts = (phraseStarts() || []).slice();
    const i = MH.hitPhraseStart(state.geom, starts, p.x);
    if (i === 0) return;
    if (erase) {
      if (i > 0) commitPhrases(starts.filter((_, k) => k !== i));
      return;
    }
    const tick = i > 0 ? starts[i] : phraseTickAt(starts, p.x, shift);
    const others = i > 0 ? starts.filter((_, k) => k !== i) : starts;
    drag = Object.assign(p, { kind: 'phrase', moved: false, adding: i < 0, others, tick, edit: state.edit });
    state.phraseDraft = normStarts(others.concat(tick));
    draw();
  }

  /** 区切り線を消す（ダブルクリック・右クリック） */
  function deletePhraseAt(p) {
    if (drag || !phraseAvailable() || phraseBusy) return;
    const starts = (phraseStarts() || []).slice();
    const i = MH.hitPhraseStart(state.geom, starts, p.x);
    if (i <= 0 || (starts[i] === addedPhrase.tick && performance.now() - addedPhrase.at < 1000)) return;
    commitPhrases(starts.filter((_, k) => k !== i));
  }

  phraseActions.querySelector('#clearPhrases').addEventListener('click', () => state.phraseEdits && !phraseBusy && commitPhrases(null));
  // 現在の「フレーズ検出」の設定で検出し直す（区切りの修正も解除）。検出の設定だけを反映し、他の未反映のパラメータは使わない
  phraseActions.querySelector('#redetectPhrases').addEventListener('click', async () => {
    if (!state.applied || !phraseAvailable() || !phraseActive() || phraseBusy) return;
    phraseBusy = true;
    try {
      await redetectPhrases();
    } finally {
      phraseBusy = false;
    }
  });
  async function redetectPhrases() {
    const range = judgeRange();
    const lose = losesEdits(true) ? '\nレーン（CC・ピッチベンド）の編集は破棄されます。' : '';
    const fix = state.phraseEdits ? `\n${range ? '選択範囲の' : ''}区切りの修正は解除されます（元に戻す／Ctrl+Z で戻せます）。` : '';
    const ok = await MH.modal.confirm({
      title: 'フレーズの再検出' + (range ? '（選択範囲）' : ''),
      message: `現在の「フレーズ検出」の設定で${range ? '選択範囲の' : ''}区切りを検出し直します。${fix}${lose}`,
      okText: '再検出する',
      danger: true,
    });
    if (!ok || !state.applied) return;
    const saved = [state.phraseAuto, state.phraseEdits];
    state.phraseAuto = state.phraseEdits = null;
    state.analyzed = false;
    // 範囲ごとのレイヤーも同じ設定にする（params はレイヤーと共有していないので、それぞれ書き換える）
    const paramSets = [state.applied.human.params, ...state.applied.human.layers.map((l) => l.params)];
    const savedParams = paramSets.map((p) => PHRASE_PARAM_KEYS.map((key) => p[key]));
    for (const p of paramSets) for (const key of PHRASE_PARAM_KEYS) if (state.params[key] !== undefined) p[key] = state.params[key];
    stopPlay();
    let done = run(true);
    // 選択範囲があれば、曲全体を検出し直した結果のうち範囲内の区切りだけを使い、範囲外は今の区切り（修正を含む）を残して処理し直す
    if (done && range) {
      const fresh = (state.phraseAuto || []).filter((t) => inJudgeRange(range, t));
      const merge = (starts) => normStarts(starts.filter((t) => !inJudgeRange(range, t)).concat(fresh));
      state.phraseAuto = merge(saved[0] || state.phraseAuto || []); // 検出済みの区切りが無ければ、範囲外も今回の検出結果にする
      state.phraseEdits = saved[1] && merge(saved[1]);
      done = run(true);
    }
    if (!done) {
      // 失敗したら検出済みの区切り・修正・検出の設定を元に戻す
      [state.phraseAuto, state.phraseEdits] = saved;
      paramSets.forEach((p, i) => PHRASE_PARAM_KEYS.forEach((key, k) => (p[key] = savedParams[i][k])));
      return;
    }
    // それより前のフレーズの履歴は、自動（null）が前の検出結果を指していたので捨てる。修正の解除だけは戻せるよう積む
    undoStack = undoStack.filter((h) => h.type !== 'phrase');
    redoStack = redoStack.filter((h) => h.type !== 'phrase');
    if (saved[1] && JSON.stringify(saved[1]) !== JSON.stringify(state.phraseEdits)) pushHistory({ type: 'phrase', before: saved[1], after: state.phraseEdits });
    syncUndoUi();
  }

  // ---------- 印（ピアノ: 左手／右手、ギター: ストローク方向）の修正 ----------
  // 元のMIDI上の開始位置で識別する。パラメータ・シードを変えて再計算しても修正が残る（MIDI編集でノートを動かしたときは付け替える）
  const noteKey = MH.noteKeyOf;
  /** 選択のキー。MIDI編集モードのノートは編集前のキー（key0。音高を動かしている途中も変わらない）、それ以外は noteKey */
  const selKey = (n) => n.key0 ?? noteKey(n);

  function showHandInfo() {
    const notes = state.edit ? state.edit.notes : [];
    if (!notes.some(marked)) {
      $('handInfo').textContent = '';
      return;
    }
    const sel = notes.filter((n) => state.selection.has(selKey(n))).length;
    $('handInfo').textContent = sel ? `選択 ${sel}` : '';
  }


  /**
   * 印の修正を確認のうえ反映する。直近の実行と同じ設定で処理し直す（未反映のパラメータ変更は使わない）。
   * 確認を待つ間に別の操作で修正が変わらないよう、確認が済んでから update で書き換える
   */
  async function applyMarks(update) {
    if (!(await confirmDiscard(false, true, true))) return;
    update();
    stopPlay();
    run(true);
  }

  /**
   * value: 印の値（'R' | 'L' | 'D' | 'U' | 'N' | 'X' | 'P'）か 'A'（すべての種類の印を判定に戻す）。判定と同じ値にしたときは修正として残さない。
   * ギターの方向・奏法は同時発音の単位なので、同じ同時発音のノートをまとめて修正する
   */
  function setMark(notes, value) {
    const kinds = value === 'A' ? marksOf() : [markFor(value)].filter(Boolean);
    const changes = [];
    for (const m of kinds) {
      let targets = notes.filter((n) => n[m.field]);
      if (m.group) {
        const ids = new Set(targets.map((n) => n[m.group]));
        targets = state.edit.notes.filter((n) => n[m.field] && ids.has(n[m.group]));
      }
      for (const n of targets) changes.push([m.overrides(), noteKey(n), value === 'A' || value === n[m.auto] ? null : value]);
    }
    if (!changes.length) return;
    applyMarks(() => {
      for (const [ov, key, v] of changes) v ? ov.set(key, v) : ov.delete(key);
    });
  }
  /** クリックで先頭の印を反転する（左手⇔右手、ダウン⇔アップ） */
  function flipMark(n) {
    const m = marksOf()[0];
    if (m && n[m.field]) setMark([n], n[m.field] === m.values[0] ? m.values[1] : m.values[0]);
  }
  const selectedNotes = () => (state.edit ? state.edit.notes.filter((n) => state.selection.has(selKey(n))) : []);

  /** ツールバーの印のボタンの押下状態を、鉛筆で塗る印に合わせる */
  function syncPaintButtons() {
    for (const m of marksOf()) for (const [id, value] of Object.entries(m.buttons)) $(id).setAttribute('aria-pressed', String(state.paintMark === value));
  }
  /**
   * 印のボタン（L・R、ギターは ↓・↑・通常・×・PM）: 鉛筆で塗る印のオン／オフ。選択中のノートがあれば、その印にしたうえでオンにする（そのときは解除しない）
   */
  function pressMark(id) {
    const m = marksOf().find((x) => id in x.buttons);
    if (!m) return;
    const value = m.buttons[id];
    const notes = selectedNotes();
    state.paintMark = notes.length || state.paintMark !== value ? value : null;
    syncPaintButtons();
    setMark(notes, value);
  }
  for (const id of ['toRight', 'toLeft', 'toNormal', 'toBrush', 'toPalm']) $(id).addEventListener('click', () => pressMark(id));
  $('toAuto').addEventListener('click', () => setMark(selectedNotes(), 'A'));
  handActions.querySelector('#clearHands').addEventListener('click', () => state.handOverrides.size && applyMarks(() => state.handOverrides.clear()));
  strumActions.querySelector('#clearStrums').addEventListener(
    'click',
    () =>
      (state.strumOverrides.size || state.articOverrides.size) &&
      applyMarks(() => {
        state.strumOverrides.clear();
        state.articOverrides.clear();
      })
  );
  /**
   * 判定し直す（手・ストローク方向で共通）。判定の設定だけを直近の実行の設定に反映し、他の未反映のパラメータは使わない
   * @param {{instrument:string, active:()=>boolean, title:string, label:string, what:string, group?:string, keys:string[], autos:Map[], overrides:Map[]}} o  label: 設定の欄の名前、what: 修正の対象の名前、group: 範囲で絞るときにまとめるノートの項目（同時発音）、keys: 判定の設定の項目、autos: 判定済みの値、overrides: ユーザーの修正
   */
  async function rejudge(o) {
    if (!state.applied || state.applied.human.instrument !== o.instrument || !o.active()) return;
    // 選択範囲があれば、範囲内のノート（ギターは範囲にかかる同時発音ごと）の判定と修正だけを解除する。範囲外は判定済みの値のまま残る
    const range = judgeRange();
    const scopeKeys = () => {
      if (!range) return null;
      const notes = state.edit ? state.edit.notes : [];
      const hit = notes.filter((n) => inJudgeRange(range, n.srcTick ?? n.tick));
      const groups = o.group ? new Set(hit.map((n) => n[o.group]).filter((g) => g != null)) : null;
      return new Set(hit.concat(groups ? notes.filter((n) => groups.has(n[o.group])) : []).map(noteKey));
    };
    let keys = scopeKeys();
    const inScope = (k) => !keys || keys.has(k);
    const fixes = o.overrides.reduce((a, m) => a + [...m.keys()].filter(inScope).length, 0);
    const lose = losesEdits(true) ? '\nレーン（CC・ピッチベンド）の編集は破棄されます。' : '';
    const ok = await MH.modal.confirm({
      title: o.title + (range ? '（選択範囲）' : ''),
      message: `現在の「${o.label}」の設定で${range ? '選択範囲を' : ''}判定し直します。\n${range ? '選択範囲の' : ''}${o.what}の修正（${fixes} 件）はすべて解除されます。${lose}`,
      okText: '再判定する',
      danger: true,
    });
    // 確認を待つ間に処理し直した・範囲を変えたときは、確認した内容と違うので反映しない
    if (!ok || !state.applied || state.applied.human.instrument !== o.instrument || JSON.stringify(judgeRange()) !== JSON.stringify(range)) return;
    keys = scopeKeys();
    const maps = o.autos.concat(o.overrides);
    const saved = maps.map((m) => new Map(m));
    for (const m of maps) for (const k of [...m.keys()]) if (inScope(k)) m.delete(k);
    state.analyzed = false; // 消した分を次の実行の前に分析し直す（失敗して値を戻した後は、次の分析で補う分が無いだけなので false のままでよい）
    // 範囲ごとのレイヤーも同じ判定にする（params はレイヤーと共有していないので、それぞれ書き換える）
    for (const p of [state.applied.human.params, ...state.applied.human.layers.map((l) => l.params)])
      for (const key of o.keys) if (state.params[key] !== undefined) p[key] = state.params[key];
    stopPlay();
    // 失敗したら判定済みの値と修正を元に戻す
    if (!run(true)) {
      maps.forEach((m, i) => {
        m.clear();
        for (const [k, v] of saved[i]) m.set(k, v);
      });
    }
  }
  strumActions.querySelector('#rejudgeStrums').addEventListener('click', () =>
    rejudge({
      instrument: 'guitar',
      active: strumActive,
      title: 'ストローク方向・奏法の再判定',
      label: 'ストロークの方向・奏法',
      what: 'ストローク方向・奏法',
      group: 'strumId',
      keys: ['strumStrongPattern', 'strumMode','estBeat', 'estVel', 'estLen', 'estVoicing', 'estOrder', 'estFlow', 'strumDirPattern', 'articMode', 'strumArticPattern', 'brushDetectBeats'],
      autos: [state.strumAuto, state.articAuto],
      overrides: [state.strumOverrides, state.articOverrides],
    })
  );
  // 現在の「左手／右手」の設定で推定し直す（手の修正も解除）
  handActions.querySelector('#rejudgeHands').addEventListener('click', () =>
    rejudge({ instrument: 'piano', active: handActive, title: '手の再判定', label: '左手／右手', what: '手', keys: ['handMode', 'handSpan', 'splitPitch'], autos: [state.handAuto], overrides: [state.handOverrides] })
  );
  $('colorMode').addEventListener('change', () => {
    state.colorModes[instrument()] = $('colorMode').value;
    syncHandUi();
    draw();
  });

  // ---------- キー操作 ----------
  // 文字入力中（シード欄など）以外では Ctrl+Z / Ctrl+Y（元に戻す・やり直し）、Space（再生／停止）、Esc（選択解除）、ピアノの R / L / A・ギターの D / U / N / X / P / A を受け付ける
  const isTyping = (el) => el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|number|search)$/.test(el.type));
  document.addEventListener('keydown', (e) => {
    // Ctrl+Z: 元に戻す、Ctrl+Y / Ctrl+Shift+Z: やり直し（押しっぱなしでも続けて戻せる）
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !isTyping(e.target)) {
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') {
        e.preventDefault();
        if (k === 'z' && !e.shiftKey) undo();
        else redo();
        return;
      }
    }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    // 設定項目の「?」は Space でも説明を開けるようにする（再生しない）
    if (e.code === 'Space' && e.target.closest && e.target.closest('.info-btn')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      // ボタン等にフォーカスがあると、キーを離したときにそのボタンも押されるため外す
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      togglePlay();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'escape' && (state.selection.size || state.pointSel || state.range)) {
      // 選択中のノート・レーンの点があればその選択を、無ければ範囲選択の区間を解除する
      if (state.selection.size || state.pointSel) {
        state.selection.clear();
        state.pointSel = null;
      } else {
        state.range = null;
        syncRunUi();
        if (loopOn() && MH.player.isPlaying()) startPlay(MH.player.position());
      }
      draw();
    } else if (sourceMode() && (k === 'delete' || k === 'backspace') && state.selection.size && !drag && !/^(SELECT|INPUT)$/.test(e.target.tagName)) {
      // MIDI編集モード: 選択したノートを消す
      e.preventDefault();
      deleteNotes(selectedNotes());
    } else if ((k === 'delete' || k === 'backspace') && !drag && !/^(SELECT|INPUT)$/.test(e.target.tagName) && selectedPoints().length) {
      // ヒューマナイズ編集: 選択したレーンの点を消す
      e.preventDefault();
      deleteSelectedPoints();
    } else if (/^[1-6]$/.test(e.key) && !e.shiftKey && !/^(SELECT|INPUT)$/.test(e.target.tagName)) {
      setTool(TOOL_KEYS[Number(e.key) - 1]);
    } else if (marksOf().length && (markKey(k) || k === 'a') && state.selection.size) {
      e.preventDefault();
      setMark(selectedNotes(), k === 'a' ? 'A' : markKey(k));
    }
  });

  // ---------- ピアノロールのマウス操作 ----------
  // ノート: ドラッグで移動・右端のドラッグで長さ変更（時間方向のみ。Shift でグリッドに吸着）。
  //   クリックはピアノなら左手⇔右手、ギターの和音ならダウン⇔アップの切り替え、それ以外は選択。選択中のノートを掴むと選択中のノートをまとめて動かす
  // 何も無い所: ドラッグで範囲選択（Shift で追加選択）
  // レーン: クリックで点を追加・点のクリックで選択（Shift で追加・解除）・点の無い所のドラッグで範囲選択・点のドラッグで移動・右クリック／Delete（選択中の点）で削除
  const roll = $('roll');
  const selBox = $('selBox');
  const valueTip = $('valueTip');
  let drag = null;
  /** レーン上のカーソル位置（キャンバスのpx）の近くに値を出す */
  function showValueTip(p, value) {
    const k = cssScale();
    valueTip.textContent = value;
    valueTip.style.left = p.x * k + 12 + 'px';
    valueTip.style.top = p.y * k - 22 + 'px';
    valueTip.classList.remove('hidden');
  }
  const hideValueTip = () => valueTip.classList.add('hidden');
  const canvasPos = (e) => {
    const rect = roll.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * roll.width) / rect.width, y: ((e.clientY - rect.top) * roll.height) / rect.height };
  };
  /**
   * カーソルが固定表示の帯・列の上にあるか。固定表示は操作を受けない（下のロールに届く）ため、
   * スクロール中はロール上の座標だけでは判別できない
   */
  const fixedAt = (e) => {
    if (!state.geom) return { ruler: false, keys: false, x: 0 };
    const rect = rollWrap.getBoundingClientRect();
    const k = cssScale();
    const x = (e.clientX - rect.left - rollWrap.clientLeft) / k; // 表示枠の左端からの位置（キャンバスのpx）
    return {
      ruler: e.clientY - rect.top - rollWrap.clientTop < state.geom.rulerH * k,
      keys: x < state.geom.keyW,
      x,
    };
  };
  /** ドラッグを打ち切る。ノート・点を動かしている途中なら、そこまでの位置で確定する */
  const cancelDrag = () => {
    const d = drag;
    drag = null;
    selBox.classList.add('hidden');
    hideValueTip();
    if (d && TOOL_DRAGS.has(d.kind)) return finishToolDrag(d, false);
    // 点はクリックだけでも追加しているので確定する
    if (d && (d.moved || d.kind === 'point' || d.kind === 'phrase')) finishDrag(d);
  };
  /** 編集層を作り直すとき、確定させずにドラッグを捨てる */
  function endDrag() {
    drag = null;
    state.paintKeys = null;
    state.phraseDraft = null;
    selBox.classList.add('hidden');
    hideValueTip();
  }

  /** 吸着するグリッドの単位（tick）。ツールバーのグリッドの値 */
  const snapUnit = () => MH.snapGridTicks(state.result.maps.ppq, $('snapGrid').value) || MH.gridTicksOf(state.result.maps.ppq, '16');
  /** グリッドに吸着するか（ツールバーのスナップ。Shift を押している間は逆） */
  const snapOn = (shift) => ($('snapToggle').getAttribute('aria-pressed') === 'true') !== !!shift;
  /** 吸着するなら吸着させた位置、しないなら1tick単位の位置 */
  const placeTick = (t, shift) => Math.max(0, Math.round(snapOn(shift) ? snapTick(t) : t));
  /**
   * 小節の頭を基準にグリッドへ吸着する
   * @param {Function} [how] グリッドの区切りの選び方（既定は最寄り。Math.floor なら前、Math.ceil なら後ろの区切り）
   */
  function snapTick(t, how = Math.round) {
    const unit = snapUnit();
    const pos = state.result.maps.position(Math.max(0, t));
    return Math.round(pos.barStartTick + how(pos.posInBar / unit) * unit);
  }

  /** @returns {object|null} カーソル位置で最後に描いた（見えている）ノート */
  const noteAt = (p) => {
    const hits = MH.hitNotes(state.geom, state.edit.notes, p.x, p.y, p.x, p.y);
    return hits[hits.length - 1] || null;
  };

  roll.tabIndex = 0; // キー操作（R/L/A/Esc）を受けられるように
  roll.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !state.geom) return;
    const p = canvasPos(e);
    const fixed = fixedAt(e);
    const inRuler = fixed.ruler || p.y < state.geom.rulerH;
    if (fixed.keys && inRuler) return e.preventDefault(); // 左上の角
    if (inRuler && e.ctrlKey && state.edit) return startRulerRange(e, p);
    if (inRuler) return startSeek(e);
    e.preventDefault();
    // preventDefault でフォーカスが移らないため、ボタン等に残ったフォーカスを外してロールに移す
    if (document.activeElement && document.activeElement !== roll) document.activeElement.blur();
    roll.focus({ preventScroll: true });
    if (MH.onSplit(state.geom, p.y)) return startViewDrag('split', e, p);
    const split = MH.hitLaneSplit(state.geom, p.y);
    if (split) return startViewDrag('lane', e, p, split);
    // 左端の列: レーン名の右のボタンで編集ロック・削除、レーンのそれ以外の部分はクリックで折りたたみを切り替える
    if (fixed.keys) {
      const btn = MH.hitLaneButton(state.geom, fixed.x, p.y);
      // 削除はダブルクリックの2回目を無視する（詰めて上がってきた次のレーンまで消さないように）
      if (btn) return btn.kind === 'lock' ? toggleLock(btn.id) : e.detail > 1 ? undefined : btn.kind === 'merge' ? mergeSections() : closeLane(btn.id);
      const id = MH.hitFold(state.geom, p.y);
      if (id) toggleFold(id);
      return;
    }
    // レーンの点の選択は、スマートで同じレーンを操作するとき以外は外す
    if (state.pointSel && !(state.tool === 'smart' && (MH.hitLane(state.geom, p.y) || {}).id === state.pointSel.id)) {
      state.pointSel = null;
      requestDraw();
    }
    // 区間のレーン: クリック・ドラッグ・Shift+クリックで区間を範囲選択にする（ズーム・範囲のツールはそのまま効く。範囲のツールは区間に揃えない範囲選択）
    if (!SECTION_TOOLS_PASS.has(state.tool) && MH.hitSectionLane(state.geom, p.y)) return e.ctrlKey ? undefined : startSectionDrag(e, p);
    if (state.tool !== 'smart') return startToolDrag(e, p);
    if (MH.hitPhraseLane(state.geom, p.y)) return e.ctrlKey ? undefined : startPhraseDrag(p, e.shiftKey, false);
    const lane = MH.hitLane(state.geom, p.y);
    // macOS の Ctrl+クリック（右クリック扱い）では点を足さない。MIDI編集モードのレーンは表示だけ
    if (lane) return e.ctrlKey || sourceMode() ? undefined : startPointDrag(lane, p, e.shiftKey);
    if (p.y >= state.geom.rollH) return; // ベロシティレーン
    const hit = noteAt(p);
    if (hit) {
      // 選択中のノートを掴んだら選択中のノートをまとめて、そうでなければそのノートだけを動かす
      const group = state.selection.has(selKey(hit)) ? selectedNotes() : [hit];
      drag = Object.assign(p, {
        kind: 'note',
        moved: false,
        hit,
        resize: MH.onNoteEdge(state.geom, hit, p.x),
        tick0: state.geom.tickAt(p.x),
        pitch0: state.geom.pitchAt(p.y),
        source: sourceMode(), // 確定のしかた（一次データの書き換え／修正値）は掴んだときのモードで決める
        orig: group.map((n) => ({ n, tick: n.tick, endTick: n.endTick, pitch: n.pitch })),
        add: e.shiftKey,
        edit: state.edit,
      });
    } else drag = Object.assign(p, { kind: 'select', moved: false, add: e.shiftKey, edit: state.edit });
  });

  // ---------- ピアノロールの表示（ノート領域の高さ・音域のスクロール・レーンの折りたたみ） ----------
  const isViewDrag = (d) => d.kind === 'split' || d.kind === 'lane';

  /**
   * 境目（split）・縦スクロールのつまみ（scroll）・レーンの下端の境目（lane）のドラッグを始める
   * @param {object} [lane] lane のとき、高さを変えるレーン（MH.hitLaneSplit の戻り値）
   */
  function startViewDrag(kind, e, p, lane) {
    if (kind === 'lane') {
      // 枠に合わせる状態のままだとノート領域が縮んで下端がカーソルに付いてこないため、今の高さで固定する
      if (state.noteViewH == null) state.noteViewH = state.geom.noteH;
      drag ={ kind, y0: e.clientY, v0: lane.h, id: lane.id };
      return;
    }
    drag = { kind, y0: e.clientY, v0: state.geom.noteH };
  }
  function viewDragTo(d, e) {
    const dy = (e.clientY - d.y0) / cssScale();
    if (d.kind === 'split') state.noteViewH = Math.max(0, d.v0 + dy); // 上限・下限は描画時に収める
    else state.laneH[d.id] = d.v0 + dy;
    requestDraw();
  }

  function toggleFold(id) {
    if (state.folded.has(id)) state.folded.delete(id);
    else state.folded.add(id);
    draw();
  }

  function toggleLock(id) {
    if (state.locked.has(id)) state.locked.delete(id);
    else state.locked.add(id);
    draw();
  }

  /** レーンを表示から外す（レーン設定の×と同じ。データは残る）。ロックは見えないまま残さないよう解除する */
  function closeLane(id) {
    state.laneIds = state.laneIds.filter((x) => x !== id);
    state.locked.delete(id);
    syncLaneTools();
    draw();
  }

  // 境目のダブルクリックで、ノート領域の高さを枠に合わせる状態に、レーンの下端なら既定の高さに戻す。
  // レーンの点のダブルクリックで、ステップ⇔スロープを切り替える
  roll.addEventListener('dblclick', (e) => {
    if (!state.geom || fixedAt(e).ruler) return;
    const p = canvasPos(e);
    const lane = MH.hitLaneSplit(state.geom, p.y);
    if (MH.onSplit(state.geom, p.y)) state.noteViewH = null;
    else if (lane) delete state.laneH[lane.id];
    else if (state.tool === 'smart' && !fixedAt(e).keys && MH.hitPhraseLane(state.geom, p.y)) return deletePhraseAt(p);
    else return toggleRamp(p, e);
    draw();
  });
  function toggleRamp(p, e) {
    const lane = state.tool === 'smart' && !sourceMode() && !fixedAt(e).keys && state.edit && MH.hitLane(state.geom, p.y);
    if (!lane || drag || exprBusy(lane)) return;
    const points = laneStore(lane.id)[lane.id] || [];
    const i = MH.hitPoint(state.geom, lane, points, p.x, p.y);
    const point = points[i];
    // 先頭の点は直前の点が無く、スロープにしても変わらない
    if (i <= 0 || (point === added.point && performance.now() - added.at < 1000)) return;
    const before = copyPoints(points);
    if (point.ramp) delete point.ramp;
    else point.ramp = true;
    commitLane(lane.id, before);
    draw();
    if (lane.id !== EXPR && MH.player.isPlaying()) startPlay(MH.player.position()); // 抑揚のレーンは処理し直した後に再生し直す（setExpr）
  }

  // ノート領域の上のホイールで音域を上下に送る（Shift・Ctrl 付きや横方向、音域の端に着いた後はブラウザに任せる）。
  // ドラッグ中は、範囲選択の枠と選ばれるノートがずれないよう送らない
  roll.addEventListener(
    'wheel',
    (e) => {
      const g = state.geom;
      if (!g || !g.scrollMax || drag || e.shiftKey || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const p = canvasPos(e);
      if (fixedAt(e).ruler || p.y < g.rulerH || p.y >= g.rollH) return;
      const unit = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? g.noteH : 1; // 行（約3音分）・ページ単位で届く環境
      const next = Math.max(0, Math.min(g.scrollMax, state.pitchScroll + e.deltaY * unit));
      if (next === state.pitchScroll) return;
      e.preventDefault();
      state.pitchScroll = next;
      requestDraw();
    },
    { passive: false }
  );

  // Ctrl+ホイールで横方向に拡大・縮小する。カーソル位置の時刻が同じ場所に残るよう横スクロールを合わせる（Cubase と同じ）
  roll.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || !state.geom || drag) return;
      e.preventDefault(); // ブラウザのページ拡大をさせない
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
      zoomTo(Number($('zoom').value) * Math.pow(1.002, -e.deltaY * unit), e.clientX);
    },
    { passive: false }
  );

  // ホイール押下のドラッグで、つかんで動かすようにスクロールする（横は表示枠、縦はノート領域なら音域・それ以外は表示枠）
  let pan = null;
  roll.addEventListener('mousedown', (e) => {
    if (e.button !== 1 || !state.geom || drag || seek) return;
    e.preventDefault(); // 自動スクロール（ホイールクリック）を出さない
    const p = canvasPos(e);
    const fixed = fixedAt(e);
    const inNotes = !fixed.ruler && p.y >= state.geom.rulerH && p.y < state.geom.rollH;
    pan = { x: e.clientX, y: e.clientY, left: rollWrap.scrollLeft, top: rollWrap.scrollTop, pitch: state.pitchScroll, inNotes };
    hideValueTip();
    rollWrap.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    if (!(e.buttons & 4)) return endPan(); // ウィンドウ外で離した等で mouseup が来なかった
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    rollWrap.scrollLeft = pan.left - dx;
    if (!pan.inNotes) rollWrap.scrollTop = pan.top - dy;
    else if (state.geom.scrollMax) {
      const next = Math.max(0, Math.min(state.geom.scrollMax, pan.pitch - dy / cssScale()));
      if (next !== state.pitchScroll) {
        state.pitchScroll = next;
        requestDraw();
      }
    }
  });
  function endPan() {
    pan = null;
    rollWrap.classList.remove('panning');
  }
  window.addEventListener('mouseup', (e) => pan && e.button === 1 && endPan());
  roll.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault()); // 環境によってはホイールクリックで貼り付け等が起きる

  // 枠の大きさが変わったら（ウィンドウの大きさ・レーンバーの段数など）描き直す。幅は右端までの描き足し、高さは枠に合わせる状態ならノート領域の高さに反映する
  new ResizeObserver(() => requestDraw()).observe($('rollWrap'));

  // 直前に追加した点と時刻（何も無い所のダブルクリックで、追加したばかりの点の種類を切り替えないように）
  let added = { point: null, at: 0 };
  /**
   * レーンの点: クリックで選択（Shift で追加・解除）・ドラッグで移動。
   * 点の無い所: ドラッグで範囲選択（Shift で追加選択）、クリックで点を追加（どちらになるかはボタンを離したときに決める）
   */
  function startPointDrag(lane, p, shift) {
    if (exprBusy(lane)) return;
    const ed = state.edit;
    const points = laneStore(lane.id)[lane.id] || [];
    const point = points[MH.hitPoint(state.geom, lane, points, p.x, p.y)];
    if (!point) {
      hideValueTip(); // 範囲選択の間、押した位置の値を残さない
      drag = Object.assign(p, { kind: 'pointBox', moved: false, lane, add: shift, edit: ed });
      return;
    }
    selectPoints(lane.id, [point], shift ? 'toggle' : 'replace');
    draw();
    drag = Object.assign(p, { kind: 'point', moved: false, lane, point, before: copyPoints(points), edit: ed });
  }

  /** 点の無い所のクリックで点を追加する（Shift でスナップを逆にする） */
  function addPointAt(d, shift) {
    const store = laneStore(d.lane.id);
    const points = (store[d.lane.id] = store[d.lane.id] || []);
    const before = copyPoints(points);
    const t = state.geom.tickAt(d.x);
    const point = { tick: Math.round(snapOn(shift) ? snapTick(t) : t), value: d.lane.valueAt(d.y) };
    added = { point, at: performance.now() };
    points.push(point);
    points.sort((a, b) => a.tick - b.tick);
    state.pointSel = null;
    finishDrag(Object.assign(d, { kind: 'point', point, before }));
  }

  /**
   * レーンの点を選択する（選択は1つのレーンの中だけ。別のレーンの点を選ぶと前の選択は外れる）
   * @param {'replace'|'add'|'toggle'} how
   */
  function selectPoints(id, points, how) {
    const cur = how !== 'replace' && state.pointSel && state.pointSel.id === id ? state.pointSel.points : new Set();
    for (const c of points) {
      if (how === 'toggle' && cur.has(c)) cur.delete(c);
      else cur.add(c);
    }
    state.pointSel = cur.size ? { id, points: cur } : null;
  }

  /** 選択中で、今も編集できるレーンにある点（ロック・折りたたみ・非表示にしたレーンや、元に戻す等で差し替わった点は含めない） */
  function selectedPoints() {
    const s = state.pointSel;
    if (!s || !state.edit || sourceMode() || state.locked.has(s.id) || state.folded.has(s.id) || !state.laneIds.includes(s.id)) return [];
    return (laneStore(s.id)[s.id] || []).filter((c) => s.points.has(c));
  }

  /** 選択中のレーンの点を消す（まとめて1つの操作として履歴に積む） */
  function deleteSelectedPoints() {
    const id = state.pointSel && state.pointSel.id;
    const sel = new Set(selectedPoints());
    if (!sel.size || exprBusy({ id })) return;
    const store = laneStore(id);
    const before = copyPoints(store[id]);
    store[id] = store[id].filter((c) => !sel.has(c));
    state.pointSel = null;
    commitLane(id, before);
    syncLaneTools();
    draw();
    if (id !== EXPR && MH.player.isPlaying()) startPlay(MH.player.position());
  }

  /** ドラッグ中の位置をノート・点に反映する */
  function dragTo(d, p, shift) {
    if (d.edit !== state.edit) return;
    if (d.kind === 'phrase') {
      d.tick = phraseTickAt(d.others, p.x, shift);
      state.phraseDraft = normStarts(d.others.concat(d.tick));
      return;
    }
    if (d.kind === 'point') {
      const t = state.geom.tickAt(p.x);
      d.point.tick = Math.max(0, Math.round(snapOn(shift) ? snapTick(t) : t));
      d.point.value = d.lane.valueAt(p.y);
      laneStore(d.lane.id)[d.lane.id].sort((a, b) => a.tick - b.tick);
      return;
    }
    const dt = state.geom.tickAt(p.x) - d.tick0;
    const h = d.orig.find((o) => o.n === d.hit);
    if (d.resize) {
      // 掴んだノートの終了位置を基準に、まとめて同じだけ伸び縮みさせる
      const end = snapOn(shift) ? snapTick(h.endTick + dt) : h.endTick + dt;
      const delta = end - h.endTick;
      for (const o of d.orig) o.n.endTick = Math.max(Math.round(o.n.tick) + 1, Math.round(o.endTick + delta));
    } else {
      const start = snapOn(shift) ? snapTick(h.tick + dt) : h.tick + dt;
      // 先頭のノートが0より前に出ないように
      const delta = Math.max(start - h.tick, -MH.minOf(d.orig, (o) => o.tick));
      for (const o of d.orig) {
        // 位置は1tick単位にそろえる（加工後のノートは小数の位置を持ちうる）
        o.n.tick = Math.max(0, Math.round(o.tick + delta));
        o.n.endTick = Math.max(o.n.tick + 1, Math.round(o.endTick + delta));
      }
      // MIDI編集モードでは音高も動かす（まとめて同じだけ。0〜127 に収まる範囲で）
      if (d.source) {
        const lo = -MH.minOf(d.orig, (o) => o.pitch);
        const hi = 127 - MH.maxOf(d.orig, (o) => o.pitch);
        const dp = Math.max(lo, Math.min(hi, state.geom.pitchAt(p.y) - d.pitch0));
        for (const o of d.orig) o.n.pitch = o.pitch + dp;
      }
    }
  }

  /**
   * ドラッグを確定する。同じ音高の重なりは、動かしていないノートを切り詰めないよう書き出し時（applyEdits）に解消する。
   * 動かした結果が元と同じなら編集として数えない
   */
  function finishDrag(d) {
    if (d.edit !== state.edit) return;
    if (d.kind === 'phrase') {
      // クリックだけなら、追加したときだけ確定する
      if (d.adding) addedPhrase = { tick: d.tick, at: performance.now() };
      if (d.moved || d.adding) commitPhrases(state.phraseDraft);
      else {
        state.phraseDraft = null;
        draw();
      }
      return;
    }
    if (d.kind === 'note' && d.source) {
      // MIDI編集モード: 一次データを書き換える
      if (d.orig.some((o) => o.n.tick !== o.tick || o.n.endTick !== o.endTick || o.n.pitch !== o.pitch)) commitSourceNotes(state.edit.notes);
      else draw();
      return;
    }
    if (d.kind === 'note') {
      const changed = d.orig.filter((o) => o.n.tick !== o.tick || o.n.endTick !== o.endTick);
      // 修正値（ヒューマナイズ後からのずれ）として覚える。修正前と同じ位置・長さに戻したノートは修正なしにする
      if (!changed.length || !changeOffsets(changed.map((o) => [noteKey(o.n), MH.noteOffsetOf(o.n)]))) return draw();
    } else if (d.kind === 'point') {
      commitLane(d.lane.id, d.before);
      syncLaneTools();
    }
    draw();
    // 再生中なら、編集後の内容で今の位置から再生し直す
    if (d.kind !== 'select' && !(d.lane && d.lane.id === EXPR) && MH.player.isPlaying()) startPlay(MH.player.position());
  }

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (!(e.buttons & 1)) return cancelDrag(); // ウィンドウ外でボタンを離した等で mouseup が来なかった
    if (isViewDrag(drag)) return viewDragTo(drag, e);
    const p = canvasPos(e);
    if (!drag.moved && Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) < 4) return;
    drag.moved = true;
    if (TOOL_DRAGS.has(drag.kind)) {
      toolDragTo(drag, p, e);
      requestDraw();
      return;
    }
    if (drag.kind !== 'select' && drag.kind !== 'pointBox') {
      dragTo(drag, p, e.shiftKey);
      if (drag.kind === 'point') showValueTip(p, drag.point.value);
      requestDraw();
      return;
    }
    // 選択枠はCSSピクセルで置く（キャンバスが拡縮表示されていてもずれないように）
    const k = roll.getBoundingClientRect().width / roll.width;
    Object.assign(selBox.style, {
      left: Math.min(p.x, drag.x) * k + 'px',
      top: Math.min(p.y, drag.y) * k + 'px',
      width: Math.abs(p.x - drag.x) * k + 'px',
      height: Math.abs(p.y - drag.y) * k + 'px',
    });
    selBox.classList.remove('hidden');
  });
  window.addEventListener('blur', cancelDrag);
  window.addEventListener('mouseup', (e) => {
    if (!drag || e.button !== 0) return;
    const d = drag;
    drag = null;
    selBox.classList.add('hidden');
    if (!state.edit || !state.geom || isViewDrag(d)) return;
    if (TOOL_DRAGS.has(d.kind)) return finishToolDrag(d, true);
    if (d.kind === 'pointBox') {
      if (d.edit !== state.edit) return;
      if (!d.moved) return addPointAt(d, e.shiftKey);
      const p = canvasPos(e);
      const hit = MH.hitPointsIn(state.geom, d.lane, laneStore(d.lane.id)[d.lane.id] || [], d.x, d.y, p.x, p.y);
      if (hit.length || !d.add) selectPoints(d.lane.id, hit, d.add ? 'add' : 'replace');
      draw();
      return;
    }
    if (d.kind !== 'select') {
      if (d.moved || d.kind === 'point' || d.kind === 'phrase') finishDrag(d);
      else if (d.kind === 'note') clickNote(d.hit, d.add);
      return;
    }
    if (d.moved) {
      const p = canvasPos(e);
      if (!d.add) state.selection.clear();
      for (const n of MH.hitNotes(state.geom, state.edit.notes, d.x, d.y, p.x, p.y)) state.selection.add(selKey(n));
      draw();
    } else if (state.selection.size) {
      state.selection.clear();
      draw();
    }
  });

  /** ノートのクリック: ピアノでは左手⇔右手、ギターの和音ではダウン⇔アップの切り替え、それ以外と Shift+クリックは選択（Shift で追加・解除） */
  function clickNote(n, add) {
    if (marked(n) && !add) return flipMark(n);
    const key = selKey(n);
    if (!add) state.selection.clear();
    if (add && state.selection.has(key)) state.selection.delete(key);
    else state.selection.add(key);
    draw();
  }

  // ---------- スマート以外の編集ツール ----------
  // 範囲選択: ドラッグで区間を選ぶ（クリックで解除）。鉛筆: ノートの手（ピアノ）・ストローク方向（ギター）の編集・レーンに点を描く。
  // 消しゴム: レーンの点を消す。ズーム: クリックで拡大・Alt+クリックで縮小。ライン: レーンに直線（スロープ）を引く
  // MIDI編集モードでは、鉛筆でノートを追加（draw）・消しゴムでノートを消す（eraseNotes）。レーンは表示だけ
  const TOOL_DRAGS = new Set(['range', 'sections', 'pencil', 'paint', 'erase', 'line', 'draw', 'eraseNotes']);
  const SECTION_TOOLS_PASS = new Set(['zoom', 'range']); // 区間のレーンでも区間の選択にせず、ツールのまま使うもの
  const PENCIL_MIN_PX = 3; // スナップなしの鉛筆で点を打つ最小の間隔（点が詰まりすぎないように）
  const ZOOM_STEP = 1.5;

  function startToolDrag(e, p) {
    const g = state.geom;
    // フレーズのレーン: 鉛筆で区切りを追加・移動、消しゴムで区切りを消す
    if ((state.tool === 'pencil' || state.tool === 'eraser') && MH.hitPhraseLane(g, p.y)) {
      if (!e.ctrlKey) startPhraseDrag(p, e.shiftKey, state.tool === 'eraser');
      return;
    }
    const lane = !e.ctrlKey && MH.hitLane(g, p.y); // macOS の Ctrl+クリック（右クリック扱い）では描かない
    if (exprBusy(lane)) return;
    const t = placeTick(g.tickAt(p.x), e.shiftKey);
    const base = { moved: false, edit: state.edit };
    if (sourceMode() && ['pencil', 'eraser', 'line'].includes(state.tool)) {
      if (e.ctrlKey || MH.hitLane(g, p.y) || p.y >= g.rollH) return;
      if (state.tool === 'pencil') startDrawNote(p, e.shiftKey, base);
      else if (state.tool === 'eraser') startEraseNotes(p, base);
      return;
    }
    switch (state.tool) {
      case 'zoom':
        return zoomTo(Number($('zoom').value) * (e.altKey ? 1 / ZOOM_STEP : ZOOM_STEP), e.clientX);
      case 'range':
        drag = Object.assign(p, base, { kind: 'range', t0: t });
        return;
      case 'pencil':
        if (lane) {
          const value = lane.valueAt(p.y);
          drag = Object.assign(p, base, { kind: 'pencil', lane, before: copyPoints(laneStore(lane.id)[lane.id] || []), last: t, cur: { tick: t, value } });
          setLanePoints(lane.id, MH.replacePoints(drag.before, t, t, [drag.cur]));
          showValueTip(p, value);
        } else if (p.y < g.rollH && marksOf().length) {
          const hit = noteAt(p);
          drag = Object.assign(p, base, { kind: 'paint', hit, notes: new Set(hit ? [hit] : []) });
          if (state.paintMark) showPaint(drag);
        }
        return;
      case 'eraser':
        if (lane) {
          drag = Object.assign(p, base, { kind: 'erase', lane, before: copyPoints(laneStore(lane.id)[lane.id] || []), lastTick: g.tickAt(p.x) });
          const points = laneStore(lane.id)[lane.id] || [];
          const i = MH.hitPoint(g, lane, points, p.x, p.y);
          if (i >= 0) setLanePoints(lane.id, points.filter((_, k) => k !== i));
        }
        return;
      case 'line':
        if (lane) {
          const value = lane.valueAt(p.y);
          drag = Object.assign(p, base, { kind: 'line', lane, before: copyPoints(laneStore(lane.id)[lane.id] || []), t0: t, v0: value });
          setLanePoints(lane.id, MH.replacePoints(drag.before, t, t, MH.linePoints(t, value, t, value)));
          showValueTip(p, value);
        }
    }
  }

  /** MIDI編集モードの鉛筆: クリックした位置（スナップがオンならグリッドの頭）にグリッド1つ分の長さのノートを置く。右へドラッグすると伸ばす */
  function startDrawNote(p, shift, base) {
    const g = state.geom;
    if (noteAt(p)) return; // ノートの上には置かない
    const unit = Math.round(snapUnit());
    const t = Math.max(0, snapOn(shift) ? snapTick(g.tickAt(p.x), Math.floor) : Math.round(g.tickAt(p.x)));
    const pitch = g.pitchAt(p.y);
    const notes = state.edit.notes;
    const note = Object.assign(MH.partFor(notes, targets(), pitch), { pitch, vel: MH.velocityNear(notes, t), offVel: 64, tick: t, endTick: t + unit });
    notes.push(note);
    drag = Object.assign(p, base, { kind: 'draw', note, unit });
    draw();
  }

  /** MIDI編集モードの消しゴム: クリック・なぞったノートを消す（離したときに消す。それまでは選択の枠で示す） */
  function startEraseNotes(p, base) {
    const hit = noteAt(p);
    drag = Object.assign(p, base, { kind: 'eraseNotes', notes: new Set(hit ? [hit] : []) });
    showPaint(drag);
    draw();
  }

  function setLanePoints(id, points) {
    laneStore(id)[id] = points;
    draw();
  }

  /** 鉛筆で手を塗っている途中のノートを、選択の枠で示す */
  function showPaint(d) {
    state.paintKeys = new Set([...d.notes].map(selKey));
  }

  function toolDragTo(d, p, e) {
    if (d.edit !== state.edit) return;
    const g = state.geom;
    const t = placeTick(g.tickAt(p.x), e.shiftKey);
    if (d.kind === 'sections') {
      const sp = sectionAt(p.x);
      state.range = { start: Math.min(d.anchor.start, sp.start), end: Math.max(d.anchor.end, sp.end) };
    } else if (d.kind === 'range') {
      state.range = { start: Math.min(d.t0, t), end: Math.max(d.t0, t) };
    } else if (d.kind === 'pencil') {
      // 前の点から今の位置までにある点を、今の点に置き換える（なぞった区間を描き直す）
      const value = d.lane.valueAt(p.y);
      showValueTip(p, value);
      const store = laneStore(d.lane.id);
      const points = store[d.lane.id];
      if (t === d.last) d.cur.value = value;
      else if (!snapOn(e.shiftKey) && Math.abs(g.x(t) - g.x(d.last)) < PENCIL_MIN_PX) return;
      else {
        d.cur = { tick: t, value };
        store[d.lane.id] = MH.replacePoints(points, t > d.last ? d.last + 1 : t, t > d.last ? t : d.last - 1, [d.cur]);
        d.last = t;
      }
    } else if (d.kind === 'line') {
      const value = d.lane.valueAt(p.y);
      showValueTip(p, value);
      laneStore(d.lane.id)[d.lane.id] = MH.replacePoints(d.before, d.t0, t, MH.linePoints(d.t0, d.v0, t, value));
    } else if (d.kind === 'erase') {
      // なぞった区間（時間方向）の点を消す
      const now = g.tickAt(p.x);
      const pad = 3 / g.scale; // 点の大きさ分の余裕
      const lo = Math.min(d.lastTick, now) - pad;
      const hi = Math.max(d.lastTick, now) + pad;
      const store = laneStore(d.lane.id);
      store[d.lane.id] = (store[d.lane.id] || []).filter((c) => c.tick < lo || c.tick > hi);
      d.lastTick = now;
    } else if (d.kind === 'draw') {
      // スナップがオンならグリッドの区切りまで伸ばす（最短でグリッド1つ分）
      const now = g.tickAt(p.x);
      const snap = snapOn(e.shiftKey);
      d.note.endTick = Math.max(d.note.tick + (snap ? d.unit : 1), snap ? snapTick(now, Math.ceil) : Math.round(now));
    } else if (d.kind === 'eraseNotes' || (d.kind === 'paint' && state.paintMark)) {
      // 前の位置から今の位置までの枠にかかるノートを塗る
      for (const n of MH.hitNotes(g, state.edit.notes, d.px ?? d.x, d.py ?? d.y, p.x, p.y)) d.notes.add(n);
      d.px = p.x;
      d.py = p.y;
      showPaint(d);
    }
  }

  /** @param {boolean} commit false ならドラッグの打ち切り（手の塗りは反映しない） */
  function finishToolDrag(d, commit) {
    hideValueTip();
    state.paintKeys = null;
    if (d.edit !== state.edit || !state.edit) return;
    if (d.kind === 'range' || d.kind === 'sections') {
      if (d.kind === 'range' && (!d.moved || !state.range || state.range.end <= state.range.start)) state.range = null; // クリック（幅0）で解除
      syncRunUi();
      draw();
      if (loopOn() && MH.player.isPlaying()) startPlay(MH.player.position());
      if (state.range) loadSectionAt(state.range.start).catch((e) => showError(e.message)); // 範囲の先頭の区間の設定を設定欄に出す
      return;
    }
    if (d.kind === 'draw') {
      if (commit) commitSourceNotes(state.edit.notes);
      else {
        state.edit.notes = state.edit.notes.filter((n) => n !== d.note);
        draw();
      }
      return;
    }
    if (d.kind === 'eraseNotes') {
      if (commit && d.notes.size) deleteNotes([...d.notes]);
      else draw();
      return;
    }
    if (d.kind === 'paint') {
      draw();
      if (!commit) return;
      if (state.paintMark) setMark([...d.notes], state.paintMark);
      else if (d.hit && !d.moved) flipMark(d.hit); // クリックで左手⇔右手（ダウン⇔アップ）を反転
      return;
    }
    commitLane(d.lane.id, d.before);
    syncLaneTools();
    draw();
    if (d.lane.id !== EXPR && MH.player.isPlaying()) startPlay(MH.player.position());
  }

  /** 横方向の拡大率を変える。clientX の位置の時刻が同じ場所に残るよう横スクロールを合わせる（Cubase と同じ） */
  function zoomTo(value, clientX) {
    const z = $('zoom');
    const old = Number(z.value);
    const next = Math.max(Number(z.min), Math.min(Number(z.max), value));
    if (next === old || !state.geom) return;
    const offset = clientX - rollWrap.getBoundingClientRect().left - rollWrap.clientLeft; // 表示枠の左端からカーソルまで（CSS px）
    const tick = state.geom.tickAt((rollWrap.scrollLeft + offset) / cssScale());
    z.value = next;
    draw();
    rollWrap.scrollLeft = Math.max(0, state.geom.x(tick) * cssScale() - offset);
  }

  // ---------- 右クリックメニュー（何も無い所の右クリック） ----------
  // 項目はツールバーのボタンを映したもので、選ぶとそのボタンを押す（処理はツールバーと共通）
  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu hidden';
  ctxMenu.setAttribute('role', 'menu');
  document.body.appendChild(ctxMenu);
  const shown = (b) => !b.closest('.hidden');
  function ctxMenuItems() {
    const btn = (id, key) => ({ button: $(id), key });
    const markKeys = { toAuto: 'A' }; // 手・奏法のボタンの id → キー
    for (const m of marksOf()) for (const [id, value] of Object.entries(m.buttons)) markKeys[id] = [...m.keys].find(([, v]) => v === value)[0].toUpperCase();
    const groups = [
      [btn('runBtn')],
      toolButtons.map((b, i) => ({ button: b, key: String(i + 1) })),
      [btn('snapToggle'), btn('loopToggle')],
      [btn('undoBtn', 'Ctrl+Z'), btn('redoBtn', 'Ctrl+Y')],
      // 手・奏法（楽器で表示中のボタンのみ）
      [...$('handTools').querySelectorAll('button')].filter(shown).map((b) => ({ button: b, key: markKeys[b.id] })),
    ];
    return groups.filter((g) => g.length);
  }
  /** ツールバーのボタンを映した項目 */
  const buttonMenuItems = () =>
    ctxMenuItems().map((group) =>
      group.map(({ button: b, key }) => {
        const on = b.getAttribute('aria-checked') ?? b.getAttribute('aria-pressed');
        return { label: b.getAttribute('aria-label'), mark: on === null ? '' : on === 'true' ? (b.hasAttribute('aria-checked') ? '●' : '✓') : '', key, disabled: b.disabled, onSelect: () => b.click() };
      })
    );
  /** @param {{label:string, mark?:string, key?:string, disabled?:boolean, onSelect:()=>void}[][]} [groups] 区切りごとの項目（省略時はツールバーのボタン） */
  function showCtxMenu(e, groups = buttonMenuItems()) {
    e.preventDefault();
    ctxMenu.replaceChildren();
    groups.forEach((group, gi) => {
      if (gi) ctxMenu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }));
      for (const { label, mark, key, disabled, onSelect } of group) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ctx-item';
        item.setAttribute('role', 'menuitem');
        item.disabled = !!disabled;
        item.append(
          Object.assign(document.createElement('span'), { className: 'ctx-mark', textContent: mark || '' }),
          Object.assign(document.createElement('span'), { className: 'ctx-label', textContent: label }),
          Object.assign(document.createElement('span'), { className: 'ctx-key', textContent: key || '' }),
        );
        item.addEventListener('click', () => {
          hideCtxMenu();
          onSelect();
        });
        ctxMenu.appendChild(item);
      }
    });
    ctxMenu.classList.remove('hidden');
    // 画面からはみ出す場合は内側にずらす
    const r = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - r.width)) + 'px';
    ctxMenu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - r.height)) + 'px';
  }
  const ctxMenuOpen = () => !ctxMenu.classList.contains('hidden');
  const hideCtxMenu = () => ctxMenu.classList.add('hidden');
  ctxMenu.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerdown', (e) => ctxMenuOpen() && !ctxMenu.contains(e.target) && hideCtxMenu(), true);
  document.addEventListener('keydown', (e) => {
    if (!ctxMenuOpen() || e.key !== 'Escape') return;
    e.stopPropagation(); // 選択の解除など、Esc の他の動作はしない
    hideCtxMenu();
  }, true);
  document.addEventListener('scroll', () => ctxMenuOpen() && hideCtxMenu(), true);
  addEventListener('resize', hideCtxMenu);
  addEventListener('blur', hideCtxMenu);

  // 右クリック: レーンの点・フレーズの区切りは削除、ノートは修正の取り消し、何も無い所はメニュー。
  // 左端の列のCC・ピッチベンド・フレーズのレーンは、そのレーンの種類を選び直すメニュー
  roll.addEventListener('contextmenu', (e) => {
    cancelDrag();
    hideCtxMenu();
    const fixed = fixedAt(e);
    if (fixed.keys && !fixed.ruler && state.geom) {
      const id = MH.hitFold(state.geom, canvasPos(e).y);
      const menu = laneTools.menuFor(id);
      if (menu && id === EXPR) menu.push([{ label: '自動に戻す', disabled: !state.exprEdits || phraseBusy, onSelect: () => resetExpr() }]);
      if (menu) showCtxMenu(e, menu);
      return;
    }
    if (fixed.ruler || fixed.keys) return;
    if (!state.geom || !state.edit) return showCtxMenu(e);
    const p = canvasPos(e);
    if (MH.hitPhraseLane(state.geom, p.y)) {
      if (phraseAvailable() && MH.hitPhraseStart(state.geom, phraseStarts() || [], p.x) >= 0) {
        e.preventDefault();
        return deletePhraseAt(p);
      }
      return showCtxMenu(e);
    }
    const lane = MH.hitLane(state.geom, p.y);
    if (lane && sourceMode()) return showCtxMenu(e); // MIDI編集モードのレーンは表示だけ
    if (exprBusy(lane)) return e.preventDefault();
    if (!lane) {
      // ノートの右クリック: そのノートの位置・長さの修正を取り消す（MIDI編集モードではノートを消す。どちらも元に戻す対象）
      const n = noteAt(p);
      if (!n) return showCtxMenu(e);
      e.preventDefault();
      if (sourceMode()) return deleteNotes([n]);
      if (!changeOffsets([[noteKey(n), null]])) return;
      draw();
      if (MH.player.isPlaying()) startPlay(MH.player.position());
      return;
    }
    const store = laneStore(lane.id);
    const points = store[lane.id] || [];
    const i = MH.hitPoint(state.geom, lane, points, p.x, p.y);
    if (i < 0) return showCtxMenu(e);
    e.preventDefault();
    const before = copyPoints(points);
    store[lane.id] = points.filter((_, k) => k !== i);
    commitLane(lane.id, before);
    syncLaneTools();
    draw();
    if (lane.id !== EXPR && MH.player.isPlaying()) startPlay(MH.player.position());
  });

  // ---------- 再生 ----------
  /** 加工後（編集後）を再生する。@param {number} [from] 再生を始める位置（省略時は再生バーの位置） */
  function startPlay(from) {
    const r = state.result;
    if (!r) return;
    let at = from ?? state.cursorTick;
    // ループする区間より後から始めるときは、区間の頭から（Cubase と同じ）
    const loop = loopRange();
    if (loop && at >= loop.end) at = loop.start;
    // サウンドフォントの音色を読み込み中なら、読み終えてから鳴らす（その間に操作し直したら、後の操作を優先する）
    const keys = Object.values(state.programs || {}).filter(Boolean);
    if (!MH.sf2.ready(keys)) {
      const token = (playToken = {});
      MH.sf2.ensure(keys).then(() => playToken === token && startPlay(from));
      return;
    }
    playToken = null;
    MH.player.play(state.edit.notes, editedCCs(), r.maps, instrument(), drumMapUi.map(), at, loop, state.programs);
  }
  let playToken = null; // 音色の読み込みを待っている再生（停止・別の操作で取り消す）
  function stopPlay() {
    playToken = null;
    MH.player.stop();
  }
  function togglePlay() {
    if (!state.result || seek) return; // 再生位置の指定中は、離したときに再生し直す

    if (MH.player.isPlaying() || playToken) stopPlay();
    else startPlay();
  }
  MH.player.onStateChange((playing) => {
    $('playToggle').classList.toggle('on', playing); // アイコンは CSS で ▶ / ■ を切り替える
    head.classList.toggle('playing', playing);
    // 再生し直し（停止→再生）でループが重ならないよう、予約済みのものを取り消してから始める
    cancelAnimationFrame(followId);
    if (playing) {
      headWasVisible = true; // 再生開始時にバーが画面外なら、そこへ送る
      lastScroll = null;
      followId = requestAnimationFrame(followHead);
    } else placeHead(state.cursorTick);
  });
  $('playToggle').addEventListener('click', togglePlay);

  // ---------- ツールバー（編集ツール・ループ・スナップ） ----------
  const toolButtons = [...document.querySelectorAll('#toolGroup [data-tool]')];
  const TOOL_KEYS = toolButtons.map((b) => b.dataset.tool); // 1〜6 キーの順
  function setTool(tool) {
    cancelDrag();
    state.tool = tool;
    for (const b of toolButtons) b.setAttribute('aria-checked', String(b.dataset.tool === tool));
    roll.style.cursor = '';
  }
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool));

  const pressed = (id) => $(id).getAttribute('aria-pressed') === 'true';
  const loopOn = () => pressed('loopToggle');
  /** ループ再生する区間（ループがオフ・区間が無ければ undefined） */
  const loopRange = () => (loopOn() && state.range && state.range.end > state.range.start ? state.range : undefined);
  $('loopToggle').addEventListener('click', () => {
    $('loopToggle').setAttribute('aria-pressed', String(!loopOn()));
    draw();
    if (MH.player.isPlaying()) startPlay(MH.player.position());
  });
  $('snapToggle').addEventListener('click', () => $('snapToggle').setAttribute('aria-pressed', String(!pressed('snapToggle'))));
  $('snapGrid').addEventListener('change', () => (state.snapUserSet = true));
  /** 実行のたびに、グリッドの値を最小音価（分からなければ16分）に合わせる（ユーザーが選んだ後は合わせない） */
  function syncSnapGrid() {
    if (state.snapUserSet || !state.result) return;
    const g = state.result.grid;
    $('snapGrid').value = '1/' + (g ? g.minGrid : '16');
  }

  const OFF_GRID_WARN_RATIO = 0.05; // グリッドから離れた音がこの割合以上なら注意を出す
  /** 直近のノーマライズで、グリッドから離れていた（揃え先の判断が微妙な）音が多ければ注意を出す（3連なしの設定で3連の曲を揃えたときなど） */
  function syncNormGridWarn() {
    const g = state.srcGrid;
    const warn = $('normGridWarn');
    const ratio = g && g.clusters ? g.offGrid / g.clusters : 0;
    const show = ratio >= OFF_GRID_WARN_RATIO;
    warn.classList.toggle('hidden', !show);
    warn.textContent = show
      ? `直前のノーマライズ（曲全体の判定）: グリッドから離れた位置の音が ${g.offGrid} 個（${Math.round(ratio * 100)}%）あり、揃え先の判断が微妙でした。` +
        (g.triplet ? '最小音価・スイングの設定を見直すと改善することがあります' : '3連を含む曲なら「3連を含む」をオンにしてください')
      : '';
  }

  // 再生中に切り替えたら、切り替えた方で今の位置から再生し直す

  // ---------- 再生バー ----------
  const head = $('playhead');
  const rollWrap = $('rollWrap');
  const cssScale = () => roll.getBoundingClientRect().width / roll.width || 1;
  const headTick = () => MH.player.position() ?? state.cursorTick;
  // 再生バーの頭の印を、固定表示の小節番号の帯に合わせて置く
  rollWrap.addEventListener('scroll', () => {
    head.firstElementChild.style.top = rollWrap.scrollTop + 'px';
    syncBars(); // 枠が縦にスクロールしたら、右端のバーをノート領域に合わせ直す
  });

  function placeHead(tick) {
    if (!state.geom) return head.classList.add('hidden');
    const k = cssScale();
    head.style.left = state.geom.x(Math.min(tick, state.geom.endTick)) * k + 'px';
    head.style.height = state.geom.height * k + 'px';
    head.classList.remove('hidden');
  }

  let followId = 0;
  let headWasVisible = true;
  let lastScroll = null;
  /**
   * 再生中は再生バーを動かす。見えていたバーが進んで画面外に出たときだけ表示位置を送る。
   * ユーザーがスクロールしてバーが見えなくなった場合は追わない（再生中に他の場所を見られるように）
   */
  function followHead() {
    const t = MH.player.position();
    if (t == null || !state.geom) return;
    placeHead(t);
    const px = state.geom.x(t) * cssScale();
    // 左端の固定表示の列に隠れている間は見えていない扱い
    const visible = px >= rollWrap.scrollLeft + state.geom.keyW * cssScale() && px <= rollWrap.scrollLeft + rollWrap.clientWidth - 40;
    const userScrolled = lastScroll != null && rollWrap.scrollLeft !== lastScroll;
    if (!visible && headWasVisible && !userScrolled) rollWrap.scrollLeft = Math.max(0, px - 80);
    else headWasVisible = visible;
    lastScroll = rollWrap.scrollLeft;
    followId = requestAnimationFrame(followHead);
  }

  // 上端の帯をクリック・ドラッグして再生位置を指定する。再生中なら、離した位置から再生し直す
  let seek = null;
  function setCursorFrom(e) {
    const r = state.result;
    let t = Math.min(state.geom.tickAt(canvasPos(e).x), state.geom.endTick);
    if (e.shiftKey) {
      const pos = r.maps.position(t);
      t = pos.barStartTick + Math.round(pos.posInBar / pos.pulseTicks) * pos.pulseTicks;
    }
    state.cursorTick = Math.max(0, Math.min(Math.round(t), state.geom.endTick));
    placeHead(state.cursorTick);
  }
  function startSeek(e) {
    e.preventDefault();
    // ボタンにフォーカスが残っていると、Space でそのボタンも押されるためロールに移す
    if (document.activeElement && document.activeElement !== roll) document.activeElement.blur();
    roll.focus({ preventScroll: true });
    seek = { resume: MH.player.isPlaying() || !!playToken }; // 音色の読み込み待ちも再生中とみなす
    stopPlay();
    setCursorFrom(e);
  }
  window.addEventListener('mousemove', (e) => {
    if (!seek) return;
    if (!(e.buttons & 1)) return endSeek();
    setCursorFrom(e);
  });
  function endSeek() {
    const s = seek;
    seek = null;
    if (s && s.resume) startPlay();
  }
  window.addEventListener('mouseup', (e) => seek && e.button === 0 && endSeek());
  /** 上端の帯の Ctrl+ドラッグで、ツールに関係なく範囲選択する（範囲選択ツールのドラッグと同じ。クリックで解除） */
  function startRulerRange(e, p) {
    e.preventDefault();
    if (document.activeElement && document.activeElement !== roll) document.activeElement.blur();
    roll.focus({ preventScroll: true });
    const t = placeTick(state.geom.tickAt(p.x), e.shiftKey);
    drag = Object.assign(p, { kind: 'range', moved: false, edit: state.edit, t0: t });
  }
  // カーソルの形で、その場所でできる操作を示す
  roll.addEventListener('mousemove', (e) => {
    if (drag || seek || pan) return;
    const p = canvasPos(e);
    const fixed = fixedAt(e);
    roll.style.cursor = cursorAt(p, fixed, e.altKey, e.ctrlKey);
    roll.title = laneButtonTitle(p, fixed);
    // レーンの上では、カーソル位置の値を出す（境目・左端の列・上端の帯の上では出さない）
    const lane = state.geom && !fixed.ruler && !fixed.keys && !MH.hitLaneSplit(state.geom, p.y) && MH.hitValueLane(state.geom, p.y);
    if (lane) showValueTip(p, lane.valueAt(p.y));
    else hideValueTip();
    drumKeyTip(e, p, fixed);
  });
  roll.addEventListener('mouseleave', () => {
    if (!drag) hideValueTip();
    MH.info.hideTip();
  });
  /** ドラムのとき、左端の列の鍵盤の上では、その音の高さに割り当てたパーツ名を出す */
  function drumKeyTip(e, p, fixed) {
    const geom = state.geom;
    if (!geom || !drumKeysActive() || !fixed.keys || fixed.ruler || p.y < geom.rulerH || p.y >= geom.rollH) return MH.info.hideTip();
    const pitch = 127 - Math.floor((p.y - geom.y(127)) / geom.rowH);
    if (pitch < 0 || pitch > 127) return MH.info.hideTip();
    const part = MH.drumAssignment(drumMapUi.map())(pitch);
    const n = state.edit ? state.edit.notes.filter((x) => x.pitch === pitch).length : 0;
    MH.info.showTipAt(roll, `${noteName(pitch)} (${pitch}) ${MH.drumPartLabel(part) || '未割り当て（その他パーカッション）'}${n ? ` ×${n}` : ''}`, e.clientX, e.clientY);
  }
  window.addEventListener('mouseup', () => !drag && !roll.matches(':hover') && hideValueTip());
  /** 左端の列のレーン名の右のボタンの説明（ボタンの上でなければ空） */
  function laneButtonTitle(p, fixed) {
    const btn = state.geom && fixed.keys && !fixed.ruler && MH.hitLaneButton(state.geom, fixed.x, p.y);
    if (!btn) return '';
    if (btn.kind === 'del') return 'レーンを削除';
    if (btn.kind === 'merge')
      return state.range && state.range.end > state.range.start
        ? '選択範囲の中の区間を結合（今の設定で処理し直す。拍子の変わる位置の境目は残る）'
        : '区間をすべて結合（今の設定で全体を処理し直す。拍子の変わる位置の境目は残る）';
    return state.locked.has(btn.id) ? '編集のロックを解除' : '編集をロック';
  }
  /** スマート以外のツールのカーソル（その場所で使えないツールなら既定の矢印） */
  function toolCursor(p, lane, alt) {
    switch (state.tool) {
      case 'range':
        return 'text';
      case 'zoom':
        return alt ? 'zoom-out' : 'zoom-in';
      case 'pencil':
        return lane ? 'crosshair' : p.y < state.geom.rollH && noteAt(p) && marked(noteAt(p)) ? 'pointer' : '';
      default: // 消しゴム・ライン
        return lane ? 'crosshair' : '';
    }
  }
  function cursorAt(p, fixed, alt, ctrl) {
    const geom = state.geom;
    if (!geom || !state.edit) return '';
    const inRuler = fixed.ruler || p.y < geom.rulerH;
    if (inRuler) return fixed.keys ? '' : ctrl ? 'text' : 'pointer';
    if (MH.onSplit(geom, p.y) || MH.hitLaneSplit(geom, p.y)) return 'ns-resize';
    if (fixed.keys) return MH.hitFold(geom, p.y) ? 'pointer' : '';
    // ロックしたレーンでは編集のツールを使えない
    if (MH.hitLockedLane(geom, p.y)) return ['range', 'zoom'].includes(state.tool) ? toolCursor(p, null, alt) : 'not-allowed';
    // Ctrl+クリックは区間を選ばないので指のカーソルにしない
    if (MH.hitSectionLane(geom, p.y)) return SECTION_TOOLS_PASS.has(state.tool) ? toolCursor(p, null, alt) : ctrl ? '' : 'pointer';
    if (MH.hitPhraseLane(geom, p.y)) {
      if (!phraseAvailable() || !['smart', 'pencil', 'eraser'].includes(state.tool)) return state.tool === 'smart' ? '' : toolCursor(p, null, alt);
      const onLine = MH.hitPhraseStart(geom, phraseStarts() || [], p.x) >= 0;
      return state.tool === 'eraser' ? (onLine ? 'pointer' : '') : onLine ? 'ew-resize' : 'copy';
    }
    const lane = MH.hitLane(geom, p.y);
    // MIDI編集モード: レーンは表示だけ。鉛筆はノートの無い所で追加、消しゴムはノートの上で消す
    if (sourceMode() && state.tool !== 'smart' && !['range', 'zoom'].includes(state.tool)) {
      if (lane || p.y >= geom.rollH) return state.tool === 'line' ? '' : 'not-allowed';
      if (state.tool === 'pencil') return noteAt(p) ? '' : 'copy';
      return state.tool === 'eraser' && noteAt(p) ? 'pointer' : '';
    }
    if (sourceMode() && lane) return '';
    if (state.tool !== 'smart') return toolCursor(p, lane, alt);
    if (lane) return MH.hitPoint(geom, lane, laneStore(lane.id)[lane.id] || [], p.x, p.y) >= 0 ? 'move' : 'crosshair';
    if (p.y >= geom.rollH) return '';
    const n = noteAt(p);
    return n ? (MH.onNoteEdge(geom, n, p.x) ? 'ew-resize' : 'move') : '';
  }

  // ---------- 右端・右下のバー（音域のスクロール・縦ズーム・横ズーム。Cubase風） ----------
  const pitchBar = $('pitchBar');
  const pitchTrack = $('pitchTrack');
  const pitchThumb = $('pitchThumb');
  const PITCH_STEP_ROWS = 3; // ▲▼で送る行数
  const PITCH_BAR_MIN_H = 150; // 右端のバーの最低限の高さ（CSS px。ボタン・縦ズームの分＋スクロールバー）
  const [ROW_MIN, , ROW_MAX] = MH.ROW_H_RANGE;
  const H_ZOOM_STEPS = 1000; // 横ズームのスライダーの段数（拡大率の対数で等分）

  /** 右端のバーの位置・つまみ・スライダーを、描いたロールに合わせる */
  function syncBars() {
    const g = state.geom;
    pitchBar.classList.toggle('hidden', !g);
    $('hZoomBox').classList.toggle('hidden', !g);
    $('hScrollBox').classList.toggle('hidden', !g);
    if (!g) return;
    const k = cssScale();
    // ノート領域の見えている部分の横に置く（上端の帯は固定表示で、ノート領域は枠の縦スクロールで上に隠れる）。
    // ノート領域が低いときも、スクロールバーとボタンを使えるよう最低限の高さを取る（下のレーンの横にはみ出す）
    pitchBar.style.top = g.rulerH * k + 'px';
    const visible = g.noteH * k - rollWrap.scrollTop;
    const room = $('vBar').clientHeight - g.rulerH * k; // 右端の列のうち、上端の帯より下（これより下は見えない）
    pitchBar.style.height = Math.max(0, Math.min(room, Math.max(PITCH_BAR_MIN_H, visible))) + 'px';
    const trackH = pitchTrack.clientHeight;
    const thumbH = Math.min(trackH, Math.max(12, trackH * (g.noteH / g.fullH)));
    pitchThumb.style.height = thumbH + 'px';
    pitchThumb.style.top = (g.scrollMax ? (g.pitchScroll / g.scrollMax) * (trackH - thumbH) : 0) + 'px';
    $('vZoom').value = g.rowH;
    syncHScroll();
    $('hZoom').value = zoomToSlider(g.scale); // 長い曲では拡大率に上限がかかるため、実際の拡大率で示す
  }

  // 横スクロールバー: ノート領域の左端から始める。つまみの幅＝見えている割合、位置＝枠の横スクロール量
  const hTrack = $('hTrack');
  const hThumb = $('hThumb');
  const H_STEP_RATIO = 0.25; // ◀▶で送る量（見えている幅に対する割合）
  function syncHScroll() {
    if (!state.geom) return;
    $('hScrollBox').style.paddingLeft = state.geom.keyW * cssScale() + 'px';
    const trackW = hTrack.clientWidth;
    const max = rollWrap.scrollWidth - rollWrap.clientWidth;
    const thumbW = Math.min(trackW, Math.max(16, (trackW * rollWrap.clientWidth) / rollWrap.scrollWidth));
    hThumb.style.width = thumbW + 'px';
    hThumb.style.left = (max > 0 ? (rollWrap.scrollLeft / max) * (trackW - thumbW) : 0) + 'px';
  }
  let hDrag = null;
  hTrack.addEventListener('mousedown', (e) => {
    const max = rollWrap.scrollWidth - rollWrap.clientWidth;
    if (e.button !== 0 || !state.geom || max <= 0) return;
    e.preventDefault();
    const track = hTrack.getBoundingClientRect();
    const thumbW = hThumb.offsetWidth;
    const range = track.width - thumbW;
    if (range <= 0) return;
    // つまみの外を押したら、つまみの中央がそこに来るよう送ってから掴む
    if (e.target !== hThumb) rollWrap.scrollLeft = ((e.clientX - track.left - thumbW / 2) / range) * max;
    hDrag = { x0: e.clientX, v0: rollWrap.scrollLeft, range, max };
    hThumb.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!hDrag) return;
    if (!(e.buttons & 1)) return endHDrag();
    rollWrap.scrollLeft = hDrag.v0 + ((e.clientX - hDrag.x0) * hDrag.max) / hDrag.range; // 範囲はブラウザが収める
  });
  function endHDrag() {
    hDrag = null;
    hThumb.classList.remove('dragging');
  }
  window.addEventListener('mouseup', () => hDrag && endHDrag());
  $('scrollLeftBtn').addEventListener('click', () => (rollWrap.scrollLeft -= rollWrap.clientWidth * H_STEP_RATIO));
  $('scrollRightBtn').addEventListener('click', () => (rollWrap.scrollLeft += rollWrap.clientWidth * H_STEP_RATIO));
  // バーの上のホイールで横に送る
  $('hScrollBox').addEventListener(
    'wheel',
    (e) => {
      if (!state.geom || e.ctrlKey) return;
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      rollWrap.scrollLeft += d * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? rollWrap.clientWidth : 1);
    },
    { passive: false }
  );

  // 音域のスクロールバー: つまみのドラッグ、つまみの外を押すとそこへ送ってから掴む、▲▼で数行ずつ送る
  let thumbDrag = null;
  pitchTrack.addEventListener('mousedown', (e) => {
    const g = state.geom;
    if (e.button !== 0 || !g || !g.scrollMax) return;
    e.preventDefault();
    const track = pitchTrack.getBoundingClientRect();
    const thumbH = pitchThumb.offsetHeight;
    const range = track.height - thumbH;
    if (range <= 0) return;
    if (e.target !== pitchThumb) {
      state.pitchScroll = ((e.clientY - track.top - thumbH / 2) / range) * g.scrollMax;
      draw();
    }
    thumbDrag = { y0: e.clientY, v0: state.pitchScroll, range };
    pitchThumb.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!thumbDrag) return;
    if (!(e.buttons & 1) || !state.geom) return endThumbDrag();
    state.pitchScroll = thumbDrag.v0 + ((e.clientY - thumbDrag.y0) * state.geom.scrollMax) / thumbDrag.range; // 範囲は描画時に収める
    requestDraw();
  });
  function endThumbDrag() {
    thumbDrag = null;
    pitchThumb.classList.remove('dragging');
  }
  window.addEventListener('mouseup', () => thumbDrag && endThumbDrag());
  const scrollPitchRows = (rows) => {
    if (!state.geom) return;
    state.pitchScroll += rows * state.geom.rowH;
    draw();
  };
  // バーの上のホイールでも音域を送る
  pitchBar.addEventListener(
    'wheel',
    (e) => {
      if (!state.geom || e.ctrlKey) return;
      e.preventDefault();
      state.pitchScroll += e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? state.geom.noteH : 1);
      requestDraw();
    },
    { passive: false }
  );
  $('pitchUp').addEventListener('click', () => scrollPitchRows(-PITCH_STEP_ROWS));
  $('pitchDown').addEventListener('click', () => scrollPitchRows(PITCH_STEP_ROWS));

  /** 縦ズーム: 1音の行の高さを変える。ノート領域の中央の音が同じ場所に残るよう音域のスクロールを合わせる */
  function setRowH(h) {
    const g = state.geom;
    const next = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.round(h)));
    if (!g || next === g.rowH) return syncBars();
    const centerRow = (g.pitchScroll + g.noteH / 2) / g.rowH;
    state.rowH = next;
    state.pitchScroll = centerRow * next - g.noteH / 2;
    draw();
  }
  $('vZoom').addEventListener('input', () => setRowH(Number($('vZoom').value)));
  $('vZoomIn').addEventListener('click', () => state.geom && setRowH(Math.max(state.geom.rowH + 1, state.geom.rowH * 1.25)));
  $('vZoomOut').addEventListener('click', () => state.geom && setRowH(Math.min(state.geom.rowH - 1, state.geom.rowH / 1.25)));

  // 横ズーム: スライダーは拡大率の対数で動かす（どの拡大率でも同じ操作量で同じ割合だけ変わる）。表示の中央の時刻を残す
  const zoomRange = () => [Number($('zoom').min), Number($('zoom').max)];
  function zoomToSlider(z) {
    const [lo, hi] = zoomRange();
    return Math.round((H_ZOOM_STEPS * Math.log(z / lo)) / Math.log(hi / lo));
  }
  function sliderToZoom(v) {
    const [lo, hi] = zoomRange();
    return lo * Math.pow(hi / lo, v / H_ZOOM_STEPS);
  }
  /** ノートを描く部分（左端の列を除く）の中央の clientX */
  function viewCenterX() {
    const r = rollWrap.getBoundingClientRect();
    const left = r.left + rollWrap.clientLeft;
    return left + (state.geom.keyW * cssScale() + rollWrap.clientWidth) / 2;
  }
  $('hZoom').addEventListener('input', () => state.geom && zoomTo(sliderToZoom(Number($('hZoom').value)), viewCenterX()));
  $('hZoomIn').addEventListener('click', () => state.geom && zoomTo(Number($('zoom').value) * ZOOM_STEP, viewCenterX()));
  $('hZoomOut').addEventListener('click', () => state.geom && zoomTo(Number($('zoom').value) / ZOOM_STEP, viewCenterX()));

  /** 加工対象のパートの表示名（'トラック2「Piano」ch1' など） */
  function partLabel(key) {
    const p = MH.listParts(state.src).find((x) => x.key === key);
    const [track, ch] = key.split(':').map(Number);
    return `トラック${track + 1}${p && p.name ? '「' + p.name + '」' : ''} ch${ch + 1}`;
  }

  // 書き出しの範囲をモーダルで選んでから書き出す。ピアノの「加工対象のトラックのみ」では、手でトラックを分けるかも選ぶ
  $('download').addEventListener('click', async () => {
    if (!state.result) return;
    const hands = handActive() && state.edit.notes.some((n) => n.hand);
    const handSub = { label: '手でトラックを分離:', options: [{ value: '1', label: '1トラック' }, { value: '2', label: '2トラック（右手・左手）' }], value: state.exportHands };
    const suffix = sourceMode() ? 'edited' : `humanized_${instrument()}`;
    const defaultName = (scope) => `${state.fileName}_${suffix}${scope === 'parts' ? '_part' : ''}`;
    const choice = await MH.modal.choose({
      title: 'MIDIの書き出し',
      message: '書き出す範囲を選んでください。',
      options: [
        { value: 'all', label: 'すべてのトラック', note: '読み込んだMIDIと同じトラック・チャンネル構成。加工対象以外は元のまま' },
        { value: 'parts', label: '加工対象のトラックのみ', note: [].concat(state.edit.parts).map(partLabel).join('、') + '（テンポ・拍子などは残す）', sub: hands ? handSub : undefined },
      ],
      value: state.exportScope,
      // 範囲を選び替えると初期値（_part の有無）も追従する。手で書き換えた後は追従しない
      input: { label: 'ファイル名（.mid）:', valueFor: defaultName, maxLength: 150 },
      okText: '書き出す',
    });
    if (!choice || !state.result) return; // キャンセルした・選ぶ間に処理に失敗して結果が無くなった
    const scope = choice.value;
    state.exportScope = scope;
    if (choice.sub) state.exportHands = choice.sub;
    const ed = state.edit;
    // 書き換えるのは編集したノート・レーンだけ（触っていないレーンは元のイベントのまま）
    const lanes = ed.dirtyLanes.size ? Object.fromEntries([...ed.dirtyLanes].map((id) => [id, ed.lanes[id] || []])) : null;
    let midi = ed.notesEdited || lanes ? MH.applyEdits(state.result.midi, { parts: ed.parts, notes: ed.notesEdited ? ed.notes : null, lanes }) : state.result.midi;
    // ギターのミュート奏法をキースイッチ・プログラムチェンジで書く（出力の設定は楽器固有の詳細設定の今の値。試聴・ピアノロールには入れない）
    const applied = state.applied;
    if (!state.result.source && applied && applied.human.instrument === 'guitar') midi = MH.writeArticulations(midi, ed.notes, INST_PARAMS.guitar);
    let out = scope === 'parts' ? MH.extractParts(midi, ed.parts) : midi;
    // 手で分けないときも、左手・右手が別トラックなら1トラックにまとめる
    if (scope === 'parts' && choice.sub) out = MH.groupHandTracks(out, choice.sub === '2', handOfEvent(ed.notes));
    const bytes = MH.writeMidi(out);
    // ファイル名に使えない文字は _ に置き換える。拡張子は付けても付けなくてもよい。空なら初期値
    const name =
      (choice.text || '')
        .trim()
        .replace(/\.(mid|midi)$/i, '')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/[.\s]+$/, '') || defaultName(scope);
    download(new Blob([bytes], { type: 'audio/midi' }), `${name}.mid`);
  });

  /** 書き出す note-on イベント → 手（編集層のノートと、チャンネル・音高・開始位置で対応させる） */
  function handOfEvent(notes) {
    const byKey = new Map(notes.map((n) => [n.ch + ':' + n.pitch + ':' + Math.round(n.tick), n.hand]));
    return (e) => byKey.get(e.ch + ':' + e.d1 + ':' + Math.round(e.tick));
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** エラーをモーダルで知らせる */
  function showError(msg) {
    if (msg) MH.modal.alert({ title: 'エラー', message: msg });
  }

  // ---------- モード ----------
  /** 設定の大項目は、ファイルを開いた後、モードで使うものだけ出す（MIDI編集＝ノーマライズ、ヒューマナイズ編集＝ヒューマナイズ） */
  function syncCatUi() {
    $('normCat').classList.toggle('hidden', !state.src || !sourceMode());
    $('humanCat').classList.toggle('hidden', !state.src || sourceMode());
  }
  function syncModeUi() {
    syncCatUi();
    syncPlayGroup();
    syncMeterWarn();
    syncRunUi();
    syncUndoUi();
    syncHandUi();
  }
  // MIDI編集へは一次データを表示するだけ。ヒューマナイズ編集へは、一次データが変わっていればヒューマナイズし直す（キャンセル・失敗ならMIDI編集のまま）
  $('mode').addEventListener('change', async () => {
    stopPlay();
    cancelDrag();
    state.paintMark = null; // 印の塗りはヒューマナイズ編集だけ
    try {
      if (state.src) {
        syncModeUi(); // 実行・描画の前に、モードで変わる表示（色分け・印のボタン）を合わせる
        if (sourceMode()) enterSource();
        else if (!(await enterHumanize())) {
          $('mode').value = 'source';
          enterSource();
        }
      }
    } catch (e) {
      showError('モードの切り替えに失敗しました: ' + e.message);
    }
    syncModeUi();
    draw();
    remember();
  });

  // ---------- 初期化 ----------
  const drumMapUi = MH.createDrumMapUi({
    host: $('drumMap'),
    onChange: () => {
      markDirty();
      draw(); // 鍵盤列・ノートのパーツの色
      if (instrument() === 'drums') autoRun();
    },
    download,
    showError,
  });
  const laneTools = MH.lanes.createLaneTools({
    addButton: $('laneAdd'),
    menuButton: $('laneMenu'),
    onChange: (ids) => {
      state.laneIds = ids;
      for (const id of ids) state.knownLanes.add(id);
      // 閉じた・種類を変えたレーンのロックは、見えないまま残さないよう解除する
      for (const id of state.locked) if (!ids.includes(id)) state.locked.delete(id);
      draw();
    },
    isLocked: (id) => state.locked.has(id),
    onToggleLock: toggleLock,
    showError,
  });
  // ピアノロールの凡例（パーツの種類別の色）
  for (const { key, label } of MH.DRUM_TYPES) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.background = MH.drumPartColor(key);
    item.append(sw, label);
    $('legendParts').appendChild(item);
  }
  $('legendParts').append('（明るさ＝ベロシティ、未割り当て＝その他パーカッション。鍵盤にカーソルを当てるとパーツ名）');
  syncFileUi();
  renderSchema(MH.NORMALIZE_SCHEMA, state.normParams, $('normParams'));
  syncModeUi(); // リロード時にブラウザが復元したモードにも表示を合わせる
  showIntensity();
  fillPresetSelect();
  applyPreset(defaultPresetKey());
  remember();
})(window);
