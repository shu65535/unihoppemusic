/**
 * MIDIファイルを開いたときの「読み込み設定」モーダル。対象チャンネル・もう片方の手のパート（ピアノのみ）・楽器を選ぶ。
 * ここで選んだ値は、ファイルを開き直すまで変えない。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const INSTRUMENTS = [
    ['piano', 'ピアノ'],
    ['guitar', 'ギター'],
    ['drums', 'ドラム'],
  ];
  const DRUM_CH = 9;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /** パートの表示名（MH.listParts の要素） */
  function partLabel(p) {
    return `ch${p.ch + 1}${p.ch === DRUM_CH ? '（ドラム）' : ''} / トラック${p.track + 1}${p.name ? ' ' + p.name : ''}（${p.notes} ノート）`;
  }

  let current = null; // 表示中のモーダル（後から開いたら前のものはキャンセル扱い）
  let lastMelodic = 'piano'; // 最後に選んだドラム以外の楽器

  /**
   * @param {{info:string, parts:Array<{key:string, ch:number, track:number, name?:string, notes:number}>, instrument:string}} opts
   *   parts はノート数の多い順。instrument は前回の楽器（初期値に使う）
   *   instSettings（任意）: { open(楽器), isOpen() }。楽器固有の詳細設定のモーダルを開くボタンを出す（開いている間はキー操作をそちらに任せる）
   * @returns {Promise<{instrument:string, part:string, extraPart:string}|null>} キャンセル時は null
   */
  function open(opts) {
    if (current) current.close(null);
    return new Promise((resolve) => {
      const back = el('div', 'modal-back');
      const box = el('div', 'modal load-modal');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.appendChild(el('h2', null, '読み込み設定'));
      box.appendChild(el('p', 'modal-msg', opts.info));

      const row = (label, sel) => {
        const l = el('label', 'row', label);
        l.appendChild(sel);
        box.appendChild(l);
        return l;
      };
      const part = el('select');
      for (const p of opts.parts) part.appendChild(new Option(partLabel(p), p.key));
      const extra = el('select');
      const inst = el('select');
      for (const [v, text] of INSTRUMENTS) inst.appendChild(new Option(text, v));
      row('楽器', inst);
      row('対象チャンネル', part);
      const extraRow = row('もう片方の手のパート', extra);
      box.appendChild(el('p', 'hint', '楽器と対象チャンネルは、ファイルを開き直すまで変更できません'));

      const isDrumPart = () => opts.parts.find((p) => p.key === part.value).ch === DRUM_CH;
      // ドラムのチャンネル以外を選んでいるときの楽器（ドラムのチャンネルから戻したときに戻す）。前回がドラムなら、その前の楽器
      let melodic = opts.instrument === 'drums' ? lastMelodic : opts.instrument;
      const fillExtra = () => {
        const keep = extra.value;
        extra.replaceChildren(new Option('なし（同じパート内で推定）', ''));
        for (const p of opts.parts) if (p.key !== part.value) extra.appendChild(new Option(partLabel(p), p.key));
        extra.value = [...extra.options].some((o) => o.value === keep) ? keep : '';
        extra.disabled = extra.options.length <= 1;
      };
      const syncExtra = () => extraRow.classList.toggle('hidden', inst.value !== 'piano');
      // 楽器はドラムのチャンネルとそれ以外を行き来したときだけ切り替える（ドラム以外どうしなら選んだ楽器のまま）
      let wasDrum = false;
      part.addEventListener('change', () => {
        const nowDrum = isDrumPart();
        if (nowDrum !== wasDrum) inst.value = nowDrum ? 'drums' : melodic;
        wasDrum = nowDrum;
        fillExtra();
        syncExtra();
      });
      inst.addEventListener('change', () => {
        if (inst.value !== 'drums') melodic = inst.value;
        syncExtra();
      });
      part.value = opts.parts[0].key;
      part.disabled = opts.parts.length <= 1;
      wasDrum = isDrumPart();
      inst.value = wasDrum ? 'drums' : melodic;
      fillExtra();
      syncExtra();

      const btns = el('div', 'modal-buttons');
      const cancel = el('button', null, 'キャンセル');
      const ok = el('button', 'primary', '読み込む');
      cancel.type = ok.type = 'button';
      // 楽器固有の詳細設定（判定・検出の設定）を、選んでいる楽器の分だけ開く。読み込む前に変えておける
      if (opts.instSettings) {
        const instBtn = el('button', 'load-inst', '楽器固有の詳細設定…');
        instBtn.type = 'button';
        instBtn.addEventListener('click', () => opts.instSettings.open(inst.value));
        btns.appendChild(instBtn);
      }
      btns.append(cancel, ok);
      box.appendChild(btns);
      back.appendChild(box);

      const prevFocus = document.activeElement;
      const close = (result) => {
        if (current !== self) return;
        current = null;
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus({ preventScroll: true });
        resolve(result);
      };
      const self = { close };
      const accept = () => {
        if (inst.value !== 'drums') lastMelodic = inst.value;
        close({ instrument: inst.value, part: part.value, extraPart: inst.value === 'piano' ? extra.value : '' });
      };
      // 画面側のショートカット（スペースで再生など）が反応しないよう、キャプチャ段階で止める
      const onKey = (e) => {
        if (MH.modal.isOpen()) return; // エラーの通知はそちらに任せる
        if (opts.instSettings && opts.instSettings.isOpen()) return; // 上に開いた楽器固有の詳細設定に任せる
        if (e.key === 'Escape') {
          e.preventDefault();
          close(null);
        } else if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'SELECT' && e.target !== cancel) {
          e.preventDefault();
          accept();
        } else if (e.key === 'Tab') {
          // フォーカスをモーダル内に閉じ込める
          const items = [...box.querySelectorAll('select:not(:disabled), button')].filter((n) => !n.closest('.hidden'));
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? items.length - 1 : 1)) % items.length;
          items[next].focus();
        }
        e.stopPropagation();
      };
      cancel.addEventListener('click', () => close(null));
      ok.addEventListener('click', accept);
      back.addEventListener('mousedown', (e) => e.target === back && close(null));
      document.addEventListener('keydown', onKey, true);
      current = self;
      document.body.appendChild(back);
      ok.focus();
    });
  }

  /** 表示中のモーダルをキャンセル扱いで閉じる */
  const cancel = () => current && current.close(null);

  MH.loadDialog = { open, cancel, partLabel, INSTRUMENTS };
})(window);
