/**
 * 説明のモーダルと、設定項目の「?」アイコン。
 * - ヘッダーの「?」で開く操作方法のモーダル。内容は index.html の #helpContent（template）
 * - 設定項目名の横の「?」: フォーカス・マウスを乗せると概要（説明の最初の1文）をツールチップで、クリックで全文をモーダルで表示する
 * 見た目・キー操作はレーン設定のモーダルに合わせる（Esc・背景クリック・×・閉じるで閉じる）
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const helpBtn = document.getElementById('helpBtn');
  const content = document.getElementById('helpContent');
  let dialog = null; // 表示中は { back, box, prevFocus }
  let refocusing = false; // モーダルを閉じて元の要素へフォーカスを戻している間

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

  /** @param {string} title @param {Node} bodyNode @param {string} [cls] モーダルに足すクラス */
  function openDialog(title, bodyNode, cls = 'help-modal') {
    if (dialog) return;
    hideTip();
    const back = el('div', 'modal-back');
    const box = el('div', `modal ${cls}`);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.tabIndex = -1;
    const head = el('div', 'dm-modal-head');
    head.appendChild(el('h2', null, title));
    const x = button('×', closeDialog, 'dm-modal-x');
    x.title = '閉じる（Esc）';
    head.appendChild(x);
    const body = el('div', 'dm-modal-body');
    body.appendChild(bodyNode);
    const foot = el('div', 'modal-buttons');
    foot.appendChild(button('閉じる', closeDialog));
    box.append(head, body, foot);
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => e.target === back && closeDialog());
    document.addEventListener('keydown', onDialogKey, true);
    dialog = { back, box, prevFocus: document.activeElement };
    document.body.appendChild(back);
    box.focus({ preventScroll: true });
  }

  function closeDialog() {
    if (!dialog) return;
    const { back, prevFocus } = dialog;
    dialog = null;
    document.removeEventListener('keydown', onDialogKey, true);
    back.remove();
    const target = prevFocus && prevFocus.isConnected ? prevFocus : helpBtn;
    // 「?」へフォーカスを戻すときは、ツールチップを出し直さない
    refocusing = true;
    if (target && target.focus) target.focus({ preventScroll: true });
    refocusing = false;
  }

  // 画面側のショートカット（スペースで再生など）が反応しないよう、キャプチャ段階で止める
  function onDialogKey(e) {
    if (MH.modal.isOpen()) return; // エラーの通知はそちらに任せる
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDialog();
    } else if (e.key === 'Tab') {
      // フォーカスをモーダル内に閉じ込める
      const items = [...dialog.box.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? items.length - 1 : 1)) % items.length;
      items[next].focus();
    }
    e.stopPropagation();
  }

  helpBtn.addEventListener('click', () => openDialog('操作方法', content.content.cloneNode(true)));

  // ---------- 設定項目の「?」 ----------
  // ツールチップは1つを使い回す。設定欄はスクロールして切り取られるため、画面に固定して表示する
  const tip = el('div', 'info-tip hidden');
  tip.id = 'infoTip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipOwner = null;

  // 概要＝説明の最初の1文（「。」まで）。2文目以降があれば more
  const summaryOf = (desc) => {
    const i = desc.indexOf('。');
    return i < 0 ? { summary: desc, more: false } : { summary: desc.slice(0, i), more: i < desc.length - 1 };
  };

  function showTip(btn) {
    const { summary, more } = btn._info;
    tip.textContent = summary;
    if (more) tip.appendChild(el('span', 'info-tip-more', 'クリックで詳細'));
    if (tipOwner && tipOwner !== btn) tipOwner.removeAttribute('aria-describedby');
    tip.classList.remove('hidden');
    tipOwner = btn;
    btn.setAttribute('aria-describedby', tip.id);
    // ボタンの下に出す。画面の右端・下端からはみ出すなら内側・上側へ寄せる（前回の位置で幅が縮まないよう左上で測る）
    tip.style.left = tip.style.top = '0';
    const r = btn.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4));
    const top = r.bottom + 6 + h > window.innerHeight ? r.top - 6 - h : r.bottom + 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }

  /** マウスの位置（画面座標 x, y）の右下にツールチップを出す（鍵盤の鍵など、要素の中の場所ごとに内容が変わるもの） */
  function showTipAt(owner, text, x, y) {
    tip.textContent = text;
    if (tipOwner && tipOwner !== owner) tipOwner.removeAttribute('aria-describedby');
    tip.classList.remove('hidden');
    tipOwner = owner;
    owner.setAttribute('aria-describedby', tip.id);
    tip.style.left = tip.style.top = '0';
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(4, Math.min(x + 12, window.innerWidth - w - 4));
    const top = y + 18 + h > window.innerHeight ? y - 8 - h : y + 18;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }

  function hideTip() {
    if (!tipOwner) return;
    tipOwner.removeAttribute('aria-describedby');
    tipOwner = null;
    tip.classList.add('hidden');
  }
  document.addEventListener('scroll', hideTip, true);
  // Esc でツールチップだけを閉じる（モーダル表示中はモーダル側が Esc を受ける）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tipOwner && !dialog) hideTip();
  });

  /**
   * 項目名の要素の末尾に「?」を付ける。モーダルの見出しは付ける前の項目名
   * @param {HTMLElement} nameEl @param {string} desc @param {string} [title]
   */
  function attach(nameEl, desc, title = nameEl.textContent.trim()) {
    if (!desc) return;
    const btn = el('button', 'info-btn', '?');
    btn.type = 'button';
    btn.setAttribute('aria-label', `${title}の説明`);
    btn._info = summaryOf(desc);
    btn.addEventListener('mouseenter', () => showTip(btn));
    btn.addEventListener('mouseleave', hideTip);
    // マウスでのクリック後や、モーダルを閉じてフォーカスが戻ったときには出さない（キーボード操作のときだけ）
    btn.addEventListener('focus', () => !refocusing && btn.matches(':focus-visible') && showTip(btn));
    btn.addEventListener('blur', hideTip);
    btn.addEventListener('click', (e) => {
      // label の中に置くため、チェックボックス等が切り替わらないようにする
      e.preventDefault();
      e.stopPropagation();
      // 1文ずつ改行して読みやすくする（閉じ括弧の前では改行しない）
      openDialog(title, el('p', 'info-detail', desc.replace(/。(?=[^」）)\s])/g, '。\n')), 'help-modal info-modal');
    });
    nameEl.appendChild(btn);
  }

  // index.html に直接書いた項目（data-desc に説明を持つ項目名）
  for (const n of document.querySelectorAll('[data-desc]')) attach(n, n.dataset.desc);

  /** 説明のモーダルを表示中か（他のダイアログがキー操作を譲るのに使う） */
  MH.info = { attach, hideTip, showTipAt, isDialogOpen: () => dialog !== null };
})(window);
