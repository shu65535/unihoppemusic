/**
 * CC・ピッチベンドのレーンの種類と、レーンの作成・削除・種類変更。
 * ピアノロールの左端の列の下端にある「＋」（作成）と「▼」（設定のモーダルを開く）、左端の列のレーン名の右クリック（種類の選び直し）で操作する。
 * CC・ピッチベンドのレーンは自動では開かない。
 * レーンを削除しても表示から外すだけで、データは残る（種類を選び直せば再び表示される）。
 * CC・ピッチベンドのほかに、フレーズの区切りのレーン（PHRASE。ピアノ・ギターのときだけ選べる）と、抑揚のレーン（EXPR。ヒューマナイズ編集のときだけ選べる。
 * ヒューマナイズへの入力で、描いた値を抑揚（自動）の山なりの代わりにベロシティへ足す。MIDI には書かない）がある。
 * ヒューマナイズの区間のレーン（SECTION）はベロシティと同じく常に表示するので、ここでは選べない（名前・色だけ持つ）。
 */
(function (root) {
  'use strict';
  const MH = root.MH;

  // 選択肢に常に出す種類（この順に並べる）
  const COMMON = ['cc64', 'cc1', 'cc11', 'cc7', 'cc10', 'cc66', 'cc67', 'pb'];
  // 各種類の役割（MIDI 規格・GM2 の一般的な割り当て。割り当ての無い番号は名前なし）
  const NAMES = {
    cc0: 'バンクセレクト', cc1: 'モジュレーション', cc2: 'ブレス', cc4: 'フット', cc5: 'ポルタメントタイム', cc6: 'データエントリー',
    cc7: 'ボリューム', cc8: 'バランス', cc10: 'パン', cc11: 'エクスプレッション', cc32: 'バンクセレクトLSB', cc38: 'データエントリーLSB',
    cc64: 'サステイン', cc65: 'ポルタメント', cc66: 'ソステヌート', cc67: 'ソフト', cc68: 'レガート', cc69: 'ホールド2',
    cc71: 'レゾナンス', cc72: 'リリースタイム', cc73: 'アタックタイム', cc74: 'カットオフ', cc84: 'ポルタメント制御',
    cc91: 'リバーブ', cc92: 'トレモロ', cc93: 'コーラス', cc94: 'セレステ', cc95: 'フェイザー',
    cc96: 'データインクリメント', cc97: 'データデクリメント', cc98: 'NRPN LSB', cc99: 'NRPN MSB', cc100: 'RPN LSB', cc101: 'RPN MSB',
    cc120: 'オールサウンドオフ', cc121: 'リセットオールコントローラー', cc123: 'オールノートオフ', pb: 'ピッチベンド',
  };
  const COLORS = { cc64: '#48dbfb', cc11: '#1dd1a1', cc1: '#feca57', cc4: '#ff9ff3', pb: '#a29bfe' };
  const CUSTOM = '__custom';
  const PHRASE = 'phrase';
  const SECTION = 'section';
  const EXPR = 'expr';

  const isLaneId = (id) => id === 'pb' || /^cc([0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(id);
  const shortLabel = (id) => (id === PHRASE ? 'フレーズ' : id === SECTION ? '区間' : id === EXPR ? '抑揚' : id === 'pb' ? 'PB' : 'CC' + id.slice(2));
  const roleName = (id) => NAMES[id] || '';
  const label = (id) => shortLabel(id) + (NAMES[id] ? ' ' + NAMES[id] : '');
  const color = (id) => (id === PHRASE ? '#f8a5c2' : id === SECTION ? '#ffb86c' : id === EXPR ? '#c39bff' : COLORS[id] || '#48dbfb');
  /** @returns {[number, number]} 値の範囲 */
  const range = (id) => (id === 'pb' ? [-8192, 8191] : id === EXPR ? MH.EXPRESSION_RANGE.slice() : [0, 127]);
  const ccOrder = (id) => (id === PHRASE ? -2 : id === EXPR ? -1 : id === 'pb' ? 1000 : Number(id.slice(2)));

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const button = (text, onClick, cls) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  /**
   * @param {{addButton:HTMLButtonElement, menuButton:HTMLButtonElement, onChange:(ids:string[])=>void, isLocked:(id:string)=>boolean, onToggleLock:(id:string)=>void, showError:(msg:string)=>void}} opts
   *   addButton: レーンの作成、menuButton: 設定のモーダルを開く、onChange: 表示するレーンが変わったとき、
   *   isLocked: レーンの編集をロックしているか、onToggleLock: モーダルの錠前のボタンでロックを切り替えたとき
   */
  function createLaneTools(opts) {
    let ids = [];
    let present = [];

    // 作成するレーンの種類: データのある種類を優先する
    const nextId = () => present.concat(COMMON).find((c) => !ids.includes(c));

    function set(next) {
      ids = next;
      sync();
      opts.onChange(ids.slice());
    }

    function sync() {
      opts.addButton.disabled = !nextId();
      renderDialog();
    }

    function addLane() {
      const next = nextId();
      if (next) set(ids.concat(next));
    }

    /** i 番目のレーンに選べる種類（同じ種類を2つのレーンに出さないため、他のレーンに出ている種類は disabled） */
    const choicesAt = (i) =>
      [...new Set(COMMON.concat(present, ids[i]))].map((c) => ({ id: c, label: label(c) + (present.includes(c) ? '' : '（空）'), disabled: c !== ids[i] && ids.includes(c) }));

    /**
     * i 番目のレーンの種類を変える。CUSTOM なら CC番号を尋ねる
     * @returns {Promise<boolean>} 変えたか
     */
    async function replaceAt(i, next) {
      const id = ids[i];
      if (next === CUSTOM) {
        const input = await MH.modal.prompt({ title: 'CC番号を指定', label: 'CC番号（0〜127）', value: '', maxLength: 3, okText: '表示' });
        next = input == null ? '' : 'cc' + String(input).trim();
        if (input != null && !isLaneId(next)) opts.showError('CC番号は 0〜127 の整数で指定してください');
        if (!isLaneId(next) || (next !== id && ids.includes(next))) return false;
      }
      if (ids[i] !== id) return false; // 尋ねている間にレーンが変わった
      set(ids.map((x, j) => (j === i ? next : x)));
      return true;
    }

    opts.addButton.addEventListener('click', () => {
      addLane();
      // 作成できる種類を使い切ってボタンが無効になったら、フォーカスを隣の設定ボタンへ移す
      if (opts.addButton.disabled) opts.menuButton.focus({ preventScroll: true });
    });
    opts.menuButton.addEventListener('click', openDialog);

    // ---------- 設定のモーダル ----------
    let dialog = null; // 表示中は { back, box, body, prevFocus }

    function openDialog() {
      if (dialog) return;
      const back = el('div', 'modal-back');
      const box = el('div', 'modal lane-modal');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.tabIndex = -1;
      const head = el('div', 'dm-modal-head');
      head.appendChild(el('h2', null, 'コントローラーレーン設定'));
      const x = button('×', closeDialog, 'dm-modal-x');
      x.title = '閉じる（Esc）';
      head.appendChild(x);
      const body = el('div', 'dm-modal-body');
      const foot = el('div', 'modal-buttons');
      foot.appendChild(button('閉じる', closeDialog));
      box.append(head, body, foot);
      back.appendChild(box);
      back.addEventListener('mousedown', (e) => e.target === back && closeDialog());
      document.addEventListener('keydown', onDialogKey, true);
      dialog = { back, box, body, prevFocus: document.activeElement };
      document.body.appendChild(back);
      renderDialog();
      box.focus({ preventScroll: true });
    }

    function closeDialog() {
      if (!dialog) return;
      const { back, prevFocus } = dialog;
      dialog = null;
      document.removeEventListener('keydown', onDialogKey, true);
      back.remove();
      const target = prevFocus && prevFocus.isConnected ? prevFocus : opts.menuButton;
      if (target && target.focus) target.focus({ preventScroll: true });
    }

    // 画面側のショートカット（スペースで再生など）が反応しないよう、キャプチャ段階で止める
    function onDialogKey(e) {
      if (MH.modal.isOpen()) return; // CC番号の入力・エラーの通知はそちらに任せる
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog();
      } else if (e.key === 'Tab') {
        // フォーカスをモーダル内に閉じ込める
        const items = [...dialog.box.querySelectorAll('button:not(:disabled), select')];
        const i = items.indexOf(document.activeElement);
        e.preventDefault();
        const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? items.length - 1 : 1)) % items.length;
        if (items.length) items[next].focus();
      }
      e.stopPropagation();
    }

    function renderDialog() {
      if (!dialog) return;
      const body = dialog.body;
      // 描き直しても操作中の欄を保つ
      const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.fk || '' : null;
      body.innerHTML = '';
      if (!ids.length) body.appendChild(el('p', 'lane-empty', 'レーンはありません'));
      ids.forEach((id, i) => {
        const row = el('div', 'lane-item');
        row.appendChild(el('span', 'lane-no', i + 1));
        const sw = el('span', 'lane-sw');
        sw.style.background = color(id);
        row.appendChild(sw);
        const sel = el('select');
        sel.title = 'このレーンに表示する種類';
        sel.dataset.fk = 'sel' + i;
        for (const c of choicesAt(i)) {
          const o = el('option', null, c.label);
          o.value = c.id;
          o.disabled = c.disabled;
          sel.appendChild(o);
        }
        const other = el('option', null, 'CC番号を指定…');
        other.value = CUSTOM;
        sel.appendChild(other);
        sel.value = id;
        sel.addEventListener('change', async () => {
          if (!(await replaceAt(i, sel.value))) renderDialog();
        });
        const locked = opts.isLocked(id);
        const lock = button('', () => {
          opts.onToggleLock(id);
          renderDialog();
        }, 'lane-lock');
        lock.title = locked ? '編集のロックを解除' : '編集をロック';
        MH.setIcon(lock, locked ? 'lock' : 'unlock', lock.title);
        lock.setAttribute('aria-pressed', String(locked));
        lock.dataset.fk = 'lock' + i;
        const del = button('×', () => set(ids.filter((_, j) => j !== i)), 'lane-x');
        del.title = 'レーンを削除（データは残る）';
        del.dataset.fk = 'del' + i;
        row.append(sel, lock, del);
        body.appendChild(row);
      });
      const add = button('＋ レーンを作成', addLane, 'lane-add');
      add.disabled = !nextId();
      add.dataset.fk = 'add';
      body.appendChild(add);
      if (focusKey === null) return;
      // 末尾の行を削除したときは、1つ上の行の削除ボタンへ
      const dels = body.querySelectorAll('.lane-x');
      const target = body.querySelector(`[data-fk="${focusKey}"]:not(:disabled)`) || (focusKey.startsWith('del') && dels[dels.length - 1]) || dialog.box;
      target.focus({ preventScroll: true });
    }

    return {
      /**
       * @param {string[]} shown 表示するレーン
       * @param {string[]} has データのあるレーン
       */
      update(shown, has) {
        ids = shown.slice();
        present = has.slice().sort((a, b) => ccOrder(a) - ccOrder(b));
        sync();
      },
      /**
       * 表示中のレーンの種類を選び直すメニューの項目（左端の列の右クリック用）
       * @returns {{label:string, mark?:string, disabled?:boolean, onSelect:()=>void}[][]|null} 区切りごとの項目。表示中のレーンでなければ null
       */
      menuFor(id) {
        const i = ids.indexOf(id);
        if (i < 0) return null;
        const pick = (next) => () => replaceAt(i, next);
        return [
          choicesAt(i).map((c) => ({ label: c.label, mark: c.id === id ? '●' : '', disabled: c.disabled, onSelect: pick(c.id) })),
          [{ label: 'CC番号を指定…', onSelect: pick(CUSTOM) }],
        ];
      },
    };
  }

  MH.lanes = { PHRASE, SECTION, EXPR, label, shortLabel, roleName, color, range, isLaneId, createLaneTools };
})(window);
