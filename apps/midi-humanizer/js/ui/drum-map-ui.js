/**
 * ドラムマップの編集UI。パーツごとに音の高さ（複数可）を割り当てる。
 * 保存したマップはブラウザ（localStorage）に残り、JSONで書き出し・読込もできる。
 */
(function (root) {
  'use strict';
  const MH = root.MH;

  const STORE_KEY = 'mh.drumMaps';
  const SELECTED_KEY = 'mh.drumMapSelected';
  const GM_ID = 'gm';
  const DIRTY_VALUE = '*'; // セレクトで「編集中の内容」を表す値（保存済みマップのIDとは重ならない）
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pitchLabel = (p) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 2} (${p})`;

  // 鍵盤（0〜127の全鍵。割り当てた鍵をパーツの色で塗る）
  const KB_WHITE_W = 12;
  const KB_H = 60;
  const KB_BLACK_W = 8;
  const KB_BLACK_H = 36;
  const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);
  const KB_KEYS = []; // { pitch, black, x, w }
  for (let p = 0, whites = 0; p < 128; p++) {
    if (isBlack(p)) KB_KEYS.push({ pitch: p, black: true, x: whites * KB_WHITE_W - KB_BLACK_W / 2, w: KB_BLACK_W });
    else KB_KEYS.push({ pitch: p, black: false, x: whites++ * KB_WHITE_W, w: KB_WHITE_W });
  }
  const KB_W = KB_KEYS.filter((k) => !k.black).length * KB_WHITE_W;

  /** キャンバス上の位置の鍵（黒鍵を優先）。鍵の外なら null */
  function keyAt(px, py) {
    const hit = (k) => px >= k.x && px < k.x + k.w;
    const k = (py < KB_BLACK_H && KB_KEYS.find((k) => k.black && hit(k))) || KB_KEYS.find((k) => !k.black && hit(k));
    return k && py >= 0 && py < KB_H ? k.pitch : null;
  }

  // 鍵盤の下のパーツ名（1文字ずつ縦に並べる）。隣の鍵の名前と重なる場合は段を分ける
  const LABEL_STEP = 10; // 1文字の高さ
  const LABEL_W = 10; // 1列の幅
  const LABEL_GAP = 4; // 鍵盤との間・段の間
  // 縦に並べると向きのおかしい文字は縦書き用の字形にする
  const VERTICAL_FORMS = { '（': '︵', '）': '︶', 'ー': '｜' };
  const verticalChars = (s) => [...s].map((c) => VERTICAL_FORMS[c] || c);

  /** 割り当てた鍵のパーツ名の配置: { labels: [{ x: 中心, y: 上端, part, chars }], height: キャンバス全体の高さ } */
  function layoutLabels(assigned) {
    const bands = []; // { right: 置いた列の右端, len: 最も長い名前の文字数, items }
    for (const k of KB_KEYS) {
      const part = assigned(k.pitch);
      if (!part) continue;
      const x = k.x + k.w / 2;
      const chars = verticalChars(MH.drumPartLabel(part) || part);
      let band = bands.find((b) => b.right <= x - LABEL_W / 2);
      if (!band) bands.push((band = { right: -Infinity, len: 0, items: [] }));
      band.right = x + LABEL_W / 2;
      band.len = Math.max(band.len, chars.length);
      band.items.push({ x, part, chars });
    }
    const labels = [];
    let y = KB_H + LABEL_GAP;
    for (const b of bands) {
      for (const it of b.items) labels.push(Object.assign(it, { y }));
      y += b.len * LABEL_STEP + LABEL_GAP;
    }
    return { labels, height: bands.length ? y : KB_H };
  }

  /**
   * @param {(pitch:number)=>string|null} assigned 音の高さ → 割り当てたパーツ
   * @param {Map<number, number>} counts 音の高さ → 対象チャンネル内のノート数（使用中の鍵に印を付ける）
   */
  function drawKeyboard(canvas, assigned, counts) {
    const { labels, height } = layoutLabels(assigned);
    if (canvas.height !== height) canvas.height = height;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, KB_W, height);
    g.font = '9px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const { x, y, part, chars } of labels) {
      g.fillStyle = MH.drumPartColor(part, 72);
      chars.forEach((c, i) => g.fillText(c, x, y + i * LABEL_STEP));
    }
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#555';
    g.fillRect(0, 0, KB_W, KB_H);
    g.font = '8px sans-serif';
    g.textAlign = 'center';
    for (const black of [false, true]) {
      for (const k of KB_KEYS) {
        if (k.black !== black) continue;
        const part = assigned(k.pitch);
        const h = black ? KB_BLACK_H : KB_H;
        g.fillStyle = part ? MH.drumPartColor(part, black ? 42 : 68) : black ? '#1a1a1a' : '#e8e8e8';
        g.fillRect(k.x + (black ? 0 : 0.5), 0, k.w - (black ? 0 : 1), h);
        if (counts.get(k.pitch)) {
          g.fillStyle = black ? '#fff' : '#222';
          g.beginPath();
          g.arc(k.x + k.w / 2, h - 6, 2, 0, Math.PI * 2);
          g.fill();
        }
        if (!black && k.pitch % 12 === 0) {
          g.fillStyle = '#555';
          g.fillText('C' + (k.pitch / 12 - 2), k.x + k.w / 2, KB_H - 12);
        }
      }
    }
  }

  // localStorage が使えない環境（設定で無効化等）でも動作は続ける
  function loadStore() {
    // 保存値は手で書き換えられうるため、"__proto__" 等のキーがプロトタイプに触れないようにする
    const out = Object.create(null);
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      for (const [id, v] of Object.entries(raw)) if (v && typeof v.name === 'string') out[id] = { name: v.name.slice(0, 60), map: MH.cleanDrumMap(v.map) };
    } catch (e) {
      /* 壊れていれば保存済みマップ無しとして扱う */
    }
    return out;
  }
  function saveStore(store, selectedId) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      localStorage.setItem(SELECTED_KEY, selectedId);
    } catch (e) {
      /* 保存できなくても編集中のマップはそのまま使える */
    }
  }

  /**
   * @param {{host:HTMLElement, onChange:()=>void, download:(blob:Blob, name:string)=>void, showError:(msg:string)=>void}} opts
   */
  function createDrumMapUi(opts) {
    const store = loadStore();
    let selectedId = GM_ID;
    try {
      const saved = localStorage.getItem(SELECTED_KEY);
      if (saved && Object.hasOwn(store, saved)) selectedId = saved;
    } catch (e) {
      /* 初期値の GM を使う */
    }
    let map = MH.cleanDrumMap(selectedId === GM_ID ? MH.GM_DRUM_MAP : store[selectedId].map);
    let active = false; // 楽器固有の詳細設定のモーダルでドラムマップを表示している間（元に戻す・やり直しを受け付ける）
    let dirty = false;
    let counts = new Map(); // 音の高さ → 対象チャンネル内のノート数
    let brush = MH.DRUM_PARTS[0].key; // 鍵盤のクリックで割り当てるパーツ
    let kbDragging = false; // 鍵盤をなぞっている間は元に戻す・やり直しを受け付けない（離したときの反映が古い内容を基準にしないように）

    const nameOf = (id) => (id === GM_ID ? 'GM標準' : store[id].name);
    const storedMap = (id) => MH.cleanDrumMap(id === GM_ID ? MH.GM_DRUM_MAP : store[id].map);

    // 編集の元に戻す・やり直し（ドラムマップを表示している間だけ。表示の開始・終了・マップの切り替えで破棄する）
    const HISTORY_MAX = 200;
    let undoStack = [];
    let redoStack = [];
    const clearHistory = () => {
      undoStack = [];
      redoStack = [];
    };

    function setMap(next) {
      if (active) {
        undoStack.push(map);
        if (undoStack.length > HISTORY_MAX) undoStack.shift();
        redoStack = [];
      }
      map = next;
      dirty = true;
      render();
      opts.onChange();
    }

    /** @param {boolean} redo */
    function stepHistory(redo) {
      if (kbDragging) return;
      const [from, to] = redo ? [redoStack, undoStack] : [undoStack, redoStack];
      if (!from.length) return;
      to.push(map);
      map = from.pop();
      // 保存済みの内容まで戻したら「編集中」を外す
      dirty = JSON.stringify(map) !== JSON.stringify(storedMap(selectedId));
      render();
      opts.onChange();
    }

    function select(id) {
      selectedId = id;
      map = storedMap(id);
      dirty = false;
      clearHistory();
      saveStore(store, selectedId);
      render();
      opts.onChange();
    }

    /** 選択中のマップへ上書き保存する（GM標準は書き換えられない） */
    function overwrite() {
      if (selectedId === GM_ID || !dirty) return;
      store[selectedId] = { name: nameOf(selectedId), map: MH.cleanDrumMap(map) };
      dirty = false;
      saveStore(store, selectedId);
      render();
    }

    async function saveAs() {
      const input = await MH.modal.prompt({ title: '名前を付けて保存', label: 'ドラムマップ名', value: selectedId === GM_ID ? '自作マップ' : nameOf(selectedId) + 'のコピー', maxLength: 60, okText: '保存' });
      const name = (input || '').trim().slice(0, 60);
      if (!name) return;
      let id = Object.keys(store).find((k) => store[k].name === name);
      if (id && !(await MH.modal.confirm({ title: '上書きの確認', message: `「${name}」を上書きしますか？`, okText: '上書き', danger: true }))) return;
      if (!id) id = 'u_' + Date.now();
      store[id] = { name, map: MH.cleanDrumMap(map) };
      selectedId = id;
      dirty = false;
      saveStore(store, selectedId);
      render();
    }

    async function remove() {
      if (selectedId === GM_ID) return;
      if (!(await MH.modal.confirm({ title: '削除の確認', message: `「${nameOf(selectedId)}」をブラウザから削除しますか？`, okText: '削除', danger: true }))) return;
      delete store[selectedId];
      select(GM_ID);
    }

    function exportJson() {
      const name = nameOf(selectedId);
      const safeName = (name + (dirty ? '（編集中）' : '')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      opts.download(new Blob([JSON.stringify(MH.drumMapToJson(name, map), null, 2)], { type: 'application/json' }), `drummap_${safeName}.json`);
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.hidden = true;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      try {
        const m = MH.parseDrumMapJson(await f.text());
        const id = 'u_' + Date.now();
        store[id] = m;
        select(id);
      } catch (err) {
        opts.showError('ドラムマップの読み込みに失敗しました: ' + err.message);
      }
    });
    document.body.appendChild(fileInput);

    // ---------- 描画 ----------
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const button = (text, fn) => {
      const b = el('button', null, text);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    };
    const iconButton = (icon, label, fn) => MH.setIcon(button(null, fn), icon, label);

    const swatch = (part) => {
      const s = el('i', 'sw');
      s.style.background = MH.drumPartColor(part);
      return s;
    };

    /**
     * 鍵盤とパーツの選択。パーツを選んで鍵をクリック（ドラッグで連続）すると割り当てる。
     * 選んだパーツの鍵から始めたときは、なぞった同じパーツの鍵の割り当てを外す。離したときに1回の編集として反映する
     */
    function keyboard() {
      const box = el('div', 'dm-kb');
      const palette = el('div', 'dm-palette');
      for (const { key, label } of MH.DRUM_PARTS) {
        const b = button('', () => {
          brush = key;
          for (const x of palette.children) x.classList.toggle('on', x === b);
        });
        b.className = 'dm-brush' + (key === brush ? ' on' : '');
        b.dataset.fk = 'brush:' + key;
        b.append(swatch(key), label);
        palette.appendChild(b);
      }
      const canvas = el('canvas', 'dm-kb-canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'ドラムマップの鍵盤（割り当てた鍵をパーツの種類の色で塗り、下にパーツ名を表示）');
      canvas.width = KB_W;
      canvas.height = KB_H;
      let drag = null; // { erase, last: 直前になぞった鍵, pending: Map<音の高さ, パーツ|null> }
      const stored = MH.drumAssignment(map);
      const assigned = () => (drag ? (p) => (drag.pending.has(p) ? drag.pending.get(p) : stored(p)) : stored);
      const redraw = () => drawKeyboard(canvas, assigned(), counts);
      const pitchAt = (e) => {
        const r = canvas.getBoundingClientRect();
        return keyAt(((e.clientX - r.left) * KB_W) / r.width, ((e.clientY - r.top) * canvas.height) / r.height);
      };
      // 素早く動かしても間の鍵が抜けないよう、直前の鍵からの範囲をまとめて塗る
      const paint = (p) => {
        if (p == null) return;
        const from = drag.last ?? p;
        for (let q = Math.min(from, p); q <= Math.max(from, p); q++) {
          if (!drag.erase || stored(q) === brush) drag.pending.set(q, drag.erase ? null : brush);
        }
        drag.last = p;
        redraw();
      };
      canvas.addEventListener('pointerdown', (e) => {
        const p = pitchAt(e);
        if (e.button !== 0 || p == null) return;
        canvas.setPointerCapture(e.pointerId);
        drag = { erase: stored(p) === brush, last: null, pending: new Map() };
        kbDragging = true;
        paint(p);
      });
      canvas.addEventListener('pointermove', (e) => {
        const p = pitchAt(e);
        if (drag) paint(p);
        const n = p == null ? 0 : counts.get(p) || 0;
        if (p == null) MH.info.hideTip();
        else MH.info.showTipAt(canvas, `${pitchLabel(p)} ${MH.drumPartLabel(assigned()(p)) || '未割り当て'}${n ? ` ×${n}` : ''}`, e.clientX, e.clientY);
      });
      canvas.addEventListener('pointerleave', () => MH.info.hideTip());
      const finish = () => {
        if (!drag) return;
        const { pending } = drag;
        drag = null;
        kbDragging = false;
        if (!active) return; // なぞっている間に閉じた
        let next = map;
        for (const [p, part] of pending) next = MH.assignDrumPitch(next, p, part);
        if (JSON.stringify(next) !== JSON.stringify(map)) setMap(next);
        else redraw();
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
      redraw();
      box.append(palette, canvas, el('p', 'hint', 'パーツを選んで鍵盤をクリックで割り当て'));
      return box;
    }

    /**
     * マップの切り替えセレクト。
     * 編集中は「名前*」を保存済みの「名前」の直前に足して選んでおく。「名前」を選び直すと保存済みの内容に戻る
     */
    function mapSelect() {
      const sel = el('select');
      sel.dataset.fk = 'map';
      for (const id of [GM_ID, ...Object.keys(store)]) {
        const label = (id === GM_ID ? '' : '★ ') + nameOf(id);
        if (id === selectedId && dirty) sel.appendChild(new Option(label + '*', DIRTY_VALUE));
        sel.appendChild(new Option(label, id));
      }
      sel.value = dirty ? DIRTY_VALUE : selectedId;
      sel.addEventListener('change', () => sel.value !== DIRTY_VALUE && select(sel.value));
      return sel;
    }

    /** Ctrl+Z: 元に戻す、Ctrl+Y / Ctrl+Shift+Z: やり直し。扱ったキーなら true（画面側のノート・レーンの元に戻すには渡さない） */
    function handleKey(e) {
      const k = e.key.toLowerCase();
      if (!active || !(e.ctrlKey || e.metaKey) || e.altKey || (k !== 'z' && k !== 'y')) return false;
      e.preventDefault();
      stepHistory(k === 'y' || e.shiftKey);
      return true;
    }

    /** 楽器固有の詳細設定のモーダルに、マップの切り替え・保存と鍵盤を置く */
    function render() {
      const host = opts.host;
      kbDragging = false; // 鍵盤を作り直すので、なぞっている途中のものは捨てる（離したイベントが届かなくなるため）
      // 描き直してもスクロール位置と操作中の欄を保つ
      const scroller = host.closest('.dm-modal-body');
      const scroll = scroller ? scroller.scrollTop : 0;
      const focusKey = host.contains(document.activeElement) ? document.activeElement.dataset.fk || '' : null;
      host.innerHTML = '';
      host.appendChild(el('h3', null, 'ドラムマップ'));

      const bar = el('div', 'dm-bar');
      const head = el('label', 'dm-map', 'マップ');
      head.appendChild(mapSelect());
      bar.appendChild(head);
      const undo = iconButton('undo', '元に戻す', () => stepHistory(false));
      undo.title = '元に戻す（Ctrl+Z）';
      undo.disabled = !undoStack.length;
      undo.dataset.fk = 'undo';
      const redo = iconButton('redo', 'やり直し', () => stepHistory(true));
      redo.title = 'やり直し（Ctrl+Y / Ctrl+Shift+Z）';
      redo.disabled = !redoStack.length;
      redo.dataset.fk = 'redo';
      const over = iconButton('save', '上書き保存', overwrite);
      over.disabled = selectedId === GM_ID || !dirty;
      over.dataset.fk = 'overwrite';
      bar.append(
        undo,
        redo,
        iconButton('open', 'ドラムマップを開く', () => fileInput.click()), // プリセットの読み込みと同じく「MIDIを開く」のアイコンで、上書き保存の前
        over,
        iconButton('saveAs', '名前を付けて保存', saveAs),
        iconButton('export', 'ドラムマップを書き出す', exportJson)
      );
      const del = iconButton('delete', '削除', remove);
      del.disabled = selectedId === GM_ID; // プリセットと同じく、消せないときも出して押せなくする
      bar.appendChild(del);
      host.appendChild(bar);
      host.appendChild(keyboard());

      if (counts.size) {
        const assigned = new Set(Object.values(map).flat());
        const unassigned = [...counts.keys()].filter((p) => !assigned.has(p)).length;
        const info = el('p', 'hint', `使用中の音の高さ ${counts.size} 種`);
        if (unassigned) info.appendChild(el('span', 'warn', `（未割り当て ${unassigned} 種）`));
        host.appendChild(info);
      }

      if (scroller) scroller.scrollTop = scroll;
      const target = focusKey && host.querySelector(`[data-fk="${CSS.escape(focusKey)}"]:not(:disabled)`); // 元に戻せなくなったボタン等は外す
      if (target) target.focus({ preventScroll: true });
      else if (focusKey !== null) host.closest('[role="dialog"]')?.focus({ preventScroll: true });
    }

    render();
    return {
      /** 現在のマップ（編集中の内容を含む） */
      map: () => map,
      /**
       * 楽器固有の詳細設定のモーダルでドラムマップを表示している間か（その間の編集を元に戻せる）。
       * 切り替えるたびに履歴を破棄する
       */
      setActive(on) {
        if (active === !!on) return;
        active = !!on;
        kbDragging = false;
        clearHistory();
        render();
      },
      handleKey,
      /** 対象チャンネルのノートから、音の高さごとのノート数を設定する */
      setNotes(notes) {
        counts = new Map();
        for (const n of notes) counts.set(n.pitch, (counts.get(n.pitch) || 0) + 1);
        render();
      },
    };
  }

  MH.createDrumMapUi = createDrumMapUi;
})(window);
