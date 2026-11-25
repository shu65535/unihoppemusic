/**
 * 確認・文字入力・選択・通知のモーダルウィンドウ（ブラウザ標準の confirm / prompt / alert の代わり）。
 * いずれも Promise を返す。Esc・背景クリックでキャンセル、Enter で決定。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  let current = null; // 表示中のモーダル（同時には1つだけ）
  let alertQueue = Promise.resolve(); // 通知は捨てずに順番に出す

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /**
   * @param {{title:string, message?:string, input?:{label?:string, value?:string, maxLength?:number, valueFor?:(choice:string)=>string}, okText?:string, cancelText?:string, danger?:boolean, noCancel?:boolean,
   *   choices?:{options:Choice[], value?:string}}} opts choices: ラジオボタンで1つ選ばせる
   *   Choice: {value:string, label:string, note?:string, sub?:{label:string, options:{value:string, label:string}[], value?:string}}
   *   （note は選択肢の下の補足。sub はその選択肢を選んでいるときだけ選べる、下に並べる副選択肢）
   *   input.valueFor: 選択肢と併用するとき、選んだ選択肢に応じた入力の初期値（手で書き換えるまで連動する）
   * @returns {Promise<{ok:boolean, value?:string, sub?:string, text?:string}>} value: 選んだ選択肢の value（選択肢が無ければ入力した文字列）。
   *   sub: 選んだ選択肢の副選択肢の value。text: 入力した文字列
   */
  function open(opts) {
    // 表示中に別の確認が来たら（モーダル表示中のドロップ等）、後から来た方をキャンセル扱いにする
    if (current) return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      const back = el('div', 'modal-back');
      const box = el('div', 'modal');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.appendChild(el('h2', null, opts.title));
      if (opts.message) box.appendChild(el('p', 'modal-msg', opts.message));
      let input = null;
      let inputRow = null;
      if (opts.input) {
        inputRow = el('label', 'row', opts.input.label || '');
        input = el('input');
        input.type = 'text';
        input.value = opts.input.value || '';
        if (opts.input.maxLength) input.maxLength = opts.input.maxLength;
        inputRow.appendChild(input);
        // 選択肢と併用するときは選択肢の下に置く
        if (!opts.choices) box.appendChild(inputRow);
      }
      // 選択肢に連動する入力の初期値。手で書き換えた後は連動させない
      let inputEdited = false;
      if (input) input.addEventListener('input', () => (inputEdited = true));
      const syncInput = (r) => {
        if (input && opts.input.valueFor && !inputEdited && r.checked) input.value = opts.input.valueFor(r.value);
      };
      let radios = [];
      const subs = new Map(); // 選択肢のラジオボタン → 副選択肢のラジオボタン
      const syncSubs = () => subs.forEach((list, r) => list.forEach((x) => (x.disabled = !r.checked)));
      if (opts.choices) {
        const group = el('div', 'modal-choices');
        group.setAttribute('role', 'radiogroup');
        const name = 'modal-choice-' + Date.now();
        const initial = opts.choices.value ?? opts.choices.options[0].value;
        radios = opts.choices.options.map((c) => {
          const label = el('label', 'modal-choice');
          const r = el('input');
          r.type = 'radio';
          r.name = name;
          r.value = c.value;
          r.checked = c.value === initial;
          const text = el('span', 'modal-choice-text');
          text.appendChild(el('span', null, c.label));
          if (c.note) text.appendChild(el('small', null, c.note));
          label.append(r, text);
          group.appendChild(label);
          r.addEventListener('change', syncSubs);
          r.addEventListener('change', () => syncInput(r));
          if (c.sub) {
            const sub = el('div', 'modal-sub');
            sub.setAttribute('role', 'radiogroup');
            sub.appendChild(el('span', 'modal-sub-label', c.sub.label));
            const subInitial = c.sub.value ?? c.sub.options[0].value;
            subs.set(
              r,
              c.sub.options.map((o) => {
                const l = el('label', 'modal-choice');
                const x = el('input');
                x.type = 'radio';
                x.name = name + '-' + c.value;
                x.value = o.value;
                x.checked = o.value === subInitial;
                l.append(x, el('span', null, o.label));
                sub.appendChild(l);
                return x;
              })
            );
            group.appendChild(sub);
          }
          return r;
        });
        box.appendChild(group);
        syncSubs();
        if (inputRow) box.appendChild(inputRow);
        radios.forEach(syncInput);
      }
      const allRadios = radios.concat(...subs.values());
      /** 選んでいる選択肢の、選んでいる副選択肢（無ければ undefined） */
      const chosenSub = () => {
        const r = radios.find((x) => x.checked);
        return r && subs.has(r) ? subs.get(r).find((x) => x.checked) : undefined;
      };
      const btns = el('div', 'modal-buttons');
      const cancel = opts.noCancel ? null : el('button', null, opts.cancelText || 'キャンセル');
      const ok = el('button', opts.danger ? 'danger' : 'primary', opts.okText || 'OK');
      ok.type = 'button';
      if (cancel) {
        cancel.type = 'button';
        btns.appendChild(cancel);
      }
      btns.appendChild(ok);
      box.appendChild(btns);
      back.appendChild(box);

      const prevFocus = document.activeElement;
      let onClosed;
      const closed = new Promise((r) => (onClosed = r));
      const close = (accepted) => {
        if (current !== self) return;
        current = null;
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
        const chosen = radios.find((r) => r.checked);
        const sub = chosenSub();
        resolve(
          accepted
            ? { ok: true, value: chosen ? chosen.value : input ? input.value : undefined, sub: sub ? sub.value : undefined, text: input ? input.value : undefined }
            : { ok: false }
        );
        onClosed();
      };
      const self = { close, closed };
      // 画面側のショートカット（スペースで再生など）が反応しないよう、キャプチャ段階で止める
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(false);
        } else if (e.key === 'Enter' && !e.isComposing && (e.target === input || e.target === ok || allRadios.includes(e.target) || !box.contains(e.target))) {
          e.preventDefault();
          close(true);
        } else if (e.key === 'Tab') {
          // フォーカスをモーダル内に閉じ込める
          // ラジオボタンは選んでいるものだけ（矢印キーで選び替える。ブラウザ標準と同じ）
          const picked = [radios.find((r) => r.checked), chosenSub()];
          const items = (opts.choices ? [...picked, input] : [input, ...picked]).concat(cancel, ok).filter(Boolean);
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
        }
        e.stopPropagation();
      };
      if (cancel) cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
      back.addEventListener('mousedown', (e) => e.target === back && close(false));
      document.addEventListener('keydown', onKey, true);
      current = self;
      document.body.appendChild(back);
      const checked = radios.find((r) => r.checked);
      if (input) {
        input.focus();
        input.select();
      } else if (checked) checked.focus();
      else ok.focus();
    });
  }

  MH.modal = {
    /** @returns {Promise<boolean>} */
    confirm: (opts) => open(opts).then((r) => r.ok),
    /**
     * 選択肢から1つ選ばせる
     * @param {{title:string, message?:string, options:object[], value?:string, okText?:string, input?:object}} opts options: 選択肢（open の Choice）、value: 最初に選んでおく選択肢、
     *   input: 選択肢の下に置く文字入力（open の input）
     * @returns {Promise<{value:string, sub?:string, text?:string}|null>} 選んだ選択肢（sub はその副選択肢、text は入力した文字列）。キャンセル時は null
     */
    choose: (opts) =>
      open(Object.assign({}, opts, { choices: { options: opts.options, value: opts.value } })).then((r) => (r.ok ? { value: r.value, sub: r.sub, text: r.text } : null)),
    /** @returns {Promise<string|null>} キャンセル時は null */
    prompt: (opts) => open(Object.assign({}, opts, { input: { label: opts.label, value: opts.value, maxLength: opts.maxLength } })).then((r) => (r.ok ? r.value : null)),
    /**
     * OK ボタンだけの通知。閉じたら解決する。
     * 他のモーダルの表示中や連続して呼ばれたときは、前のものが閉じるのを待って順番に出す。
     * @returns {Promise<void>}
     */
    alert: (opts) =>
      (alertQueue = alertQueue.then(async () => {
        while (current) await current.closed;
        await open(Object.assign({}, opts, { noCancel: true }));
      })),
    /** 確認・入力・通知のモーダルを表示中か（他のダイアログがキー操作を譲るのに使う） */
    isOpen: () => current !== null,
  };
})(window);
