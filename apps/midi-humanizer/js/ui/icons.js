/**
 * ボタン用のアイコン（16×16 の線画。stroke は文字色、.fill は塗りつぶす部分。ツールバーと同じ描き方）。
 * HTML では <button data-icon="名前" aria-label="説明"> と書くと、読み込み時にアイコンに置き換える。
 * JS で作るボタンは MH.setIcon(ボタン, 名前, 説明) で付ける。説明は title（ホバーで出る）と aria-label に入れる。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  // 右手（鍵盤に指を置いた手を、弾く人から見下ろした形。上が鍵盤、下が手の甲で親指が左）。左手は左右反転
  // 手は指先を丸めた輪郭1本で描き、指の間を縦線で区切る（指に厚みを持たせる）
  const HAND =
    '<path d="M1.5 3.5h13" /><path class="fill" d="M3.3 1h1.4v2.5H3.3zM6.1 1h1.4v2.5H6.1zM10.1 1h1.4v2.5h-1.4zM12.9 1h1.4v2.5h-1.4z" />' +
    '<path d="M4.6 10.4V7.4a1.2 1.2 0 0 1 2.4 0V6.8a1.2 1.2 0 0 1 2.4 0v.6a1.2 1.2 0 0 1 2.4 0v1.2a1 1 0 0 1 2 0V12c0 1.7-1.3 3-3 3H8c-1.3 0-2.2-.5-3.1-1.6L2.3 11.2a1.2 1.2 0 0 1 1.8-1.45z" />' +
    '<path d="M7 7.4v3.2M9.4 7.4v3.2M11.8 8.6v2" />';

  const ICONS = {
    handRight: HAND,
    handLeft: `<g transform="matrix(-1 0 0 1 16 0)">${HAND}</g>`,
    // ファイルを開く（フォルダ）
    open: '<path d="M2 12.5v-9h4l1.5 1.5H13v1.5" /><path d="M2 12.5 4 7h10.5l-2 5.5z" />',
    // ファイルから読み込む（トレーから上向きの矢印）
    import: '<path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6" /><path d="M2.5 10.5v3h11v-3" />',
    // ファイルに書き出す（下向きの矢印。ツールバーのMIDI書き出しと同じ）
    export: '<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13.5h10" />',
    // 上書き保存（フロッピー）
    save: '<path d="M2.5 2.5h9l2 2v9h-11z" /><path d="M5 2.5v3h5v-3" /><path d="M5 13.5V9.5h6v4" />',
    // 名前を付けて保存（フロッピー＋プラス）
    saveAs: '<path d="M8.5 13.5h-6v-11h8l2 2v4" /><path d="M4.5 2.5v3h4.5v-3" /><path d="M12.5 10.5v4M10.5 12.5h4" />',
    // 削除（ゴミ箱）
    delete: '<path d="M2.5 4.5h11M6 4.5v-2h4v2" /><path d="m4 4.5.7 9h6.6l.7-9" /><path d="M6.5 7v4M9.5 7v4" />',
    // 修正・値を元に戻す（×の入った反時計回りの矢印。元に戻す・再判定の矢印と見分けられるよう×を入れる）
    reset: '<path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M4.4 1.6v2.9h2.9" /><path d="m6.3 6.3 3.4 3.4M9.7 6.3l-3.4 3.4" />',
    // 判定・検出し直す（時計回りの2本の矢印）
    refresh: '<path d="M13 7.5A5 5 0 0 0 3.8 5" /><path d="M3.5 2v3h3" /><path d="M3 8.5A5 5 0 0 0 12.2 11" /><path d="M12.5 14v-3h-3" />',
    // 元に戻す・やり直し（ツールバーと同じ）
    undo: '<path d="M5 3 2 6l3 3" /><path d="M2 6h7.5a4 4 0 0 1 0 8H6" />',
    redo: '<path d="m11 3 3 3-3 3" /><path d="M14 6H6.5a4 4 0 0 0 0 8H10" />',
    // 編集ロック（閉じた錠前）・解除（つるの右側を浮かせた錠前）
    lock: '<rect x="3.5" y="7.5" width="9" height="6.5" rx="1" /><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />',
    unlock: '<rect x="3.5" y="7.5" width="9" height="6.5" rx="1" /><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v.5" />',
  };

  /** ボタンの中身をアイコンにする。説明は title（未設定のときだけ。呼び直しても変えない）と aria-label に入れる */
  MH.setIcon = (btn, name, label) => {
    if (!ICONS[name]) {
      console.warn('unknown icon:', name);
      return btn;
    }
    btn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
    btn.classList.add('ic-btn');
    if (label) {
      btn.setAttribute('aria-label', label);
      if (!btn.title) btn.title = label;
    }
    return btn;
  };

  for (const b of document.querySelectorAll('button[data-icon]')) MH.setIcon(b, b.dataset.icon, b.getAttribute('aria-label'));
})(typeof window !== 'undefined' ? window : globalThis);
