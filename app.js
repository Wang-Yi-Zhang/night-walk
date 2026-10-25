(function () {
  'use strict';

  const cfg = window.NIGHT_WALK_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const MOCK = params.has('mock');
  const NICK_MAX = 12;
  const MSG_MAX = 200;
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const REFRESH_MS = 60000;
  const ICS_PATH = 'event.ics';
  const IN_LINE = /\bLine\//.test(navigator.userAgent); // LINE 內建瀏覽器
  // 「Apple／其他」按鈕：config.js 的 appleCalendar，或網址加 ?applecal 單獨測試
  const APPLE_ON = cfg.appleCalendar === true || params.has('applecal');

  const $ = id => document.getElementById(id);

  let api = null;
  let state = null;
  let prevConfirmed = null;
  let view = null; // 'success' 時停留在成功畫面
  let success = null;
  let forceForm = false;
  let submitting = false;
  let icsInfo = null; // event.ics 的開始／結束時間（UTC），讀不到就是 null
  let icsHint = null; // LINE 裡按過「Apple／其他」後的提示：{ container, copied }

  // ── API ──────────────────────────────────────────

  function realApi(url) {
    async function request(init) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, Object.assign({ signal: ctrl.signal }, init));
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      get: () => request({ cache: 'no-store' }),
      // 不加自訂 header：維持 CORS「簡單請求」，Apps Script 才收得到
      post: payload => request({ method: 'POST', body: JSON.stringify(payload) }),
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── 本機記憶（只存在這支手機的瀏覽器） ───────────────

  const store = {
    key: id => 'night-walk:' + id,
    read(id) {
      try { return JSON.parse(localStorage.getItem(this.key(id)) || 'null'); } catch (e) { return null; }
    },
    write(id, value) {
      try { localStorage.setItem(this.key(id), JSON.stringify(value)); } catch (e) { /* 無痕模式等 */ }
    },
  };

  // ── 格式化 ───────────────────────────────────────

  function parseDate(text) {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text || '');
    return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
  }

  function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec((text || '').trim());
    return m ? { h: +m[1], mi: +m[2] } : null;
  }

  function weekday(p) {
    return WEEK[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
  }

  function fmtWhen(ev) {
    const p = parseDate(ev.date);
    const time = ev.start + (ev.end ? '–' + ev.end : '');
    return p ? p.y + '/' + p.mo + '/' + p.d + '（' + weekday(p) + '）' + time : (ev.date + ' ' + time).trim();
  }

  function fmtDeadline(text) {
    if (!text) return '不截止';
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}:\d{2})$/.exec(text);
    if (!m) return text;
    const p = { y: +m[1], mo: +m[2], d: +m[3] };
    return p.mo + '/' + p.d + '（' + weekday(p) + '）' + m[4];
  }

  const pad = n => String(n).padStart(2, '0');

  // ── 畫面：活動資訊 ────────────────────────────────

  function setField(name, value) {
    document.querySelectorAll('[data-field="' + name + '"]').forEach(el => { el.textContent = value; });
  }

  function renderEvent(ev) {
    const [main, sub] = String(ev.name || '').split('・');
    setField('title-main', main || ev.name);
    setField('title-sub', sub || '');
    setField('kicker', '夜間生態觀察' + (ev.title ? '・' + ev.title : ''));
    setField('when', fmtWhen(ev));
    setField('place', ev.place);
    setField('route', ev.route);
    setField('fee', ev.fee);
    setField('deadline', fmtDeadline(ev.deadline));
    setField('rainRule', ev.rainRule);
    setField('contactLine', ev.contactLine);
    setField('contactEmail', ev.contactEmail);
    $('email-link').href = 'mailto:' + ev.contactEmail;
    const map = $('map-link');
    map.hidden = !ev.mapUrl;
    if (ev.mapUrl) map.href = ev.mapUrl;
    document.title = ev.name + '｜線上報名';

    const list = $('bring-list');
    list.replaceChildren(...(ev.bring || []).map(text => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
    list.closest('.card').hidden = !(ev.bring && ev.bring.length);

    renderInfoCalendar(ev);

    const banner = $('status-banner');
    if (ev.status && ev.status !== '正常舉行') {
      const icon = ev.status.indexOf('雨') >= 0 ? '⛈ ' : ev.status.indexOf('延') >= 0 ? '📅 ' : '📢 ';
      const strong = document.createElement('strong');
      strong.textContent = icon + '本場' + ev.status;
      const p = document.createElement('p');
      p.textContent = ev.statusNote || '請留意本頁公告。';
      banner.replaceChildren(strong, p);
      banner.classList.remove('info');
      banner.hidden = false;
    } else if (ev.statusNote) {
      // 正常舉行但有補充說明（例如改期公告）：顯示提示橫幅，報名照常開放
      const strong = document.createElement('strong');
      strong.textContent = '📢 公告';
      const p = document.createElement('p');
      p.textContent = ev.statusNote;
      banner.replaceChildren(strong, p);
      banner.classList.add('info');
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // ── 畫面：人數 ───────────────────────────────────

  function renderSeats(s) {
    const nC = s.confirmed.length;
    const nW = s.waitlist.length;
    const remaining = Math.max(0, s.capacity - nC);

    $('count-confirmed').textContent = nC;
    $('count-capacity').textContent = s.capacity;

    const total = Math.max(s.capacity, nC);
    const lanterns = [];
    for (let i = 0; i < total; i++) {
      const el = document.createElement('span');
      el.className = 'lantern' + (i < nC ? ' on' : '');
      if (prevConfirmed !== null && i >= prevConfirmed && i < nC) el.classList.add('new');
      lanterns.push(el);
    }
    $('lanterns').replaceChildren(...lanterns);
    prevConfirmed = nC;

    const note = $('seats-note');
    const parts = [];
    const accent = text => { const b = document.createElement('span'); b.className = 'accent'; b.textContent = text; return b; };
    const sub = text => { const b = document.createElement('span'); b.className = 'sub'; b.textContent = text; return b; };
    const reason = s.registration.reason;
    if (reason === 'status' || reason === 'deadline' || reason === 'closed') {
      parts.push(reason === 'status' ? '本場' + s.event.status : reason === 'deadline' ? '報名已截止' : '報名已關閉');
      if (nW > 0) parts.push(sub('・候補 ' + nW + ' 人'));
    } else if (nW > 0) {
      parts.push(remaining > 0 ? '名額保留給候補中' : '正取已額滿', sub('・候補 ' + nW + '/' + s.waitlistCapacity));
    } else if (remaining > 0) {
      parts.push('剩餘 ', accent(String(remaining)), ' 個名額');
    } else if (s.waitlistCapacity > 0) {
      parts.push('正取已額滿', sub('・開放候補 ' + s.waitlistCapacity + ' 位'));
    } else {
      parts.push('名額已滿');
    }
    note.replaceChildren(...parts);
    $('lanterns').setAttribute('aria-label', '已報名 ' + nC + ' 人，上限 ' + s.capacity + ' 人');

    const toggle = $('roster-toggle');
    toggle.hidden = nC + nW === 0;
    toggle.querySelector('span').textContent = '看看誰會來（' + (nC + nW) + '）';
    fillChips($('roster-confirmed'), s.confirmed, '還沒有人');
    fillChips($('roster-waitlist'), s.waitlist, '');
    $('roster-waitlist-wrap').hidden = nW === 0;
    if (nC + nW === 0) {
      $('roster').hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  function fillChips(ul, names, emptyText) {
    const items = names.map(n => {
      const li = document.createElement('li');
      li.textContent = n;
      return li;
    });
    if (!items.length && emptyText) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = emptyText;
      items.push(li);
    }
    ul.replaceChildren(...items);
  }

  // ── 畫面：報名區 ─────────────────────────────────

  const VIEWS = ['view-loading', 'view-error', 'view-closed', 'view-registered', 'view-form', 'view-success'];

  function show(id) {
    VIEWS.forEach(v => { $(v).hidden = v !== id; });
  }

  function renderSignup(s) {
    const ev = s.event;
    if (view === 'success' && success) return renderSuccess(s);

    const rec = store.read(ev.id);
    if (rec && !forceForm) return renderRegistered(s, rec);

    const reg = s.registration;
    if (!reg.open) return renderClosed(s, reg.reason);

    const form = $('view-form');
    const hint = $('form-hint');
    if (reg.mode === '候補') {
      $('form-title').textContent = '登記候補';
      hint.textContent = (s.capacity - s.confirmed.length > 0 ? '目前名額保留給候補中' : '正取已額滿') +
        '，送出後你會是候補第 ' + (s.waitlist.length + 1) + ' 位，有空位時主辦會聯絡你。';
      hint.hidden = false;
      $('submit').textContent = '登記候補';
    } else {
      $('form-title').textContent = forceForm ? '幫朋友報名' : '我要報名';
      hint.hidden = true;
      $('submit').textContent = '送出報名';
    }
    if (form.hidden) show('view-form');
  }

  function renderClosed(s, reason) {
    const ev = s.event;
    const title = $('closed-title');
    const text = $('closed-text');
    if (reason === 'status') {
      title.textContent = '本場' + ev.status;
      text.textContent = ev.statusNote || '請留意本頁公告。';
    } else if (reason === 'deadline') {
      title.textContent = '報名已截止';
      text.textContent = '謝謝大家的熱情！已報名的朋友請準時集合。';
    } else if (reason === 'full') {
      title.textContent = '名額已滿';
      text.textContent = '正取 ' + s.capacity + ' 位' + (s.waitlistCapacity ? '、候補 ' + s.waitlistCapacity + ' 位' : '') + '都已額滿，下次請早！';
    } else {
      title.textContent = '報名已關閉';
      text.textContent = '有問題歡迎聯絡主辦。';
    }
    show('view-closed');
  }

  function renderRegistered(s, rec) {
    const ev = s.event;
    const inC = s.confirmed.indexOf(rec.nickname) >= 0;
    const inW = s.waitlist.indexOf(rec.nickname) >= 0;
    let status = rec.status;
    if (status === '候補' && inC && !inW) {
      status = '正取';
      store.write(ev.id, Object.assign({}, rec, { status: '正取' }));
    }
    const found = inC || inW;

    $('reg-nickname').textContent = rec.nickname;
    const pill = $('reg-status');
    pill.textContent = status;
    pill.className = 'pill' + (status === '候補' ? ' wait' : '');
    pill.hidden = !found;

    let text;
    if (!found) text = '在目前名單中找不到你的暱稱，報名可能已取消。如有疑問請聯絡主辦。';
    else if (status === '正取' && rec.status === '候補') text = '好消息！你已遞補為正取，' + fmtWhen(ev) + ' ' + ev.place + ' 見！';
    else if (status === '正取') text = fmtWhen(ev) + '，' + ev.place + ' 見！';
    else text = '你在候補名單中，有空位時主辦會聯絡你。';
    $('reg-text').textContent = text;

    renderCalendar($('view-registered').querySelector('[data-cal]'), found ? ev : null);
    $('register-another').hidden = !s.registration.open;
    show('view-registered');
  }

  function renderSuccess(s) {
    const ev = s.event;
    const isWait = success.status === '候補';
    $('success-title').textContent = isWait ? '已登記候補！' : '報名成功！';
    const b = document.createElement('b');
    b.textContent = String(success.position);
    $('success-text').replaceChildren(
      ...(isWait
        ? ['你目前是候補第 ', b, ' 位，有空位時主辦會聯絡你。']
        : ['你是第 ', b, ' 位夜行者，到時見！'])
    );
    $('ticket-nickname').textContent = success.nickname;
    renderCalendar($('view-success').querySelector('[data-cal]'), ev);
    show('view-success');
  }

  // ── 加入行事曆 ───────────────────────────────────

  function renderCalendar(container, ev) {
    container.replaceChildren();
    if (!ev) return;
    const d = parseDate(ev.date);
    const t1 = parseTime(ev.start);
    const t2 = parseTime(ev.end) || (t1 && window.NightWalkTime.defaultEnd(t1));
    if (!d || !t1) return;

    const title = ev.name + (ev.title ? '（' + ev.title + '）' : '');
    const details = [
      '本活動需事先報名，名額有限',
      '集合：' + ev.place,
      ev.route ? '路線：' + ev.route : '',
      ev.bring && ev.bring.length ? '記得帶：' + ev.bring.join('、') : '',
      ev.rainRule || '',
      location.origin + location.pathname,
    ].filter(Boolean).join('\n');

    const local = t => '' + d.y + pad(d.mo) + pad(d.d) + 'T' + pad(t.h) + pad(t.mi) + '00';
    const g = new URL('https://calendar.google.com/calendar/render');
    g.searchParams.set('action', 'TEMPLATE');
    g.searchParams.set('text', title);
    g.searchParams.set('dates', local(t1) + '/' + local(t2));
    g.searchParams.set('ctz', 'Asia/Taipei');
    g.searchParams.set('location', ev.place);
    g.searchParams.set('details', details);

    const gBtn = document.createElement('a');
    gBtn.className = 'btn btn-ghost btn-small';
    gBtn.href = g.toString();
    gBtn.target = '_blank';
    gBtn.rel = 'noopener';
    gBtn.textContent = '📅 Google 日曆';

    // iPhone 只接受網站上真的存在的 .ics 檔（event.ics，用 tools/make_ics.py 產生）。
    // 檔案的時間和試算表不一致時不顯示按鈕，避免加錯日期。
    const utc = t => new Date(Date.UTC(d.y, d.mo - 1, d.d, t.h - 8, t.mi)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const icsMatches = APPLE_ON && icsInfo && icsInfo.start === utc(t1) && icsInfo.end === utc(t2);
    const icsUrl = new URL(ICS_PATH, location.href).toString();
    const buttons = [gBtn];
    if (icsMatches) {
      const iBtn = document.createElement(IN_LINE ? 'button' : 'a');
      iBtn.className = 'btn btn-ghost btn-small';
      iBtn.textContent = '🗓 Apple／其他';
      if (IN_LINE) {
        // LINE 內建瀏覽器會把 .ics 交給 iPhone 當「訂閱行事曆」處理並改用 http，一定失敗
        // （openExternalBrowser=1 對網頁裡的連結無效）。改成複製連結，請使用者貼到 Safari。
        iBtn.type = 'button';
        iBtn.addEventListener('click', async () => {
          let copied = false;
          try {
            await navigator.clipboard.writeText(icsUrl);
            copied = true;
          } catch (err) {
            /* 不能自動複製就顯示連結讓使用者自己複製 */
          }
          icsHint = { container, copied };
          renderIcsHint(container, icsUrl, !copied);
        });
      } else {
        iBtn.href = icsUrl;
      }
      buttons.push(iBtn);
    }
    container.classList.toggle('single', buttons.length === 1);
    container.replaceChildren(...buttons);
    // 每分鐘自動更新會重畫按鈕，提示要保留
    if (icsMatches && IN_LINE && icsHint && icsHint.container === container) renderIcsHint(container, icsUrl, false);
  }

  function renderIcsHint(container, icsUrl, focus) {
    const hint = document.createElement('div');
    hint.className = 'cal-hint';
    const p = document.createElement('p');
    p.textContent = icsHint.copied
      ? '已複製行事曆連結。LINE 裡無法直接加入，請打開 Safari，把連結貼到網址列開啟，再按「加入行事曆」。'
      : 'LINE 裡無法直接加入。請複製下面的連結，打開 Safari 貼到網址列開啟，再按「加入行事曆」。';
    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = icsUrl;
    input.addEventListener('focus', () => input.setSelectionRange(0, input.value.length));
    hint.append(p, input);
    const old = container.querySelector('.cal-hint');
    if (old) old.replaceWith(hint);
    else container.append(hint);
    if (focus) input.focus();
  }

  // 活動資訊卡片常駐行事曆按鈕：換瀏覽器或清除資料後，已報名者還是找得到。取消或延期時不顯示。
  function renderInfoCalendar(ev) {
    const box = $('info-cal');
    const container = box.querySelector('[data-cal]');
    renderCalendar(container, !ev.status || ev.status === '正常舉行' ? ev : null);
    box.hidden = !container.querySelector('.btn');
  }

  // ── 表單 ─────────────────────────────────────────

  const charLen = s => Array.from(s).length;

  function normalizePhone(v) {
    let p = String(v || '').replace(/[\s\-().]/g, '');
    p = p.replace(/^\+?886(?=9)/, '0');
    return p;
  }

  // 與 apps-script/Code.gs 的 normalizeLineId_／normalizeIg_ 相同
  function normalizeLineId(v) {
    let s = String(v || '').trim();
    const m = s.match(/line\.me\/ti\/p\/~([^/?#\s]+)/i);
    if (m) s = m[1];
    return s.replace(/^@/, '').toLowerCase();
  }

  function normalizeIg(v) {
    let s = String(v || '').trim();
    const m = s.match(/instagram\.com\/([^/?#\s]+)/i);
    if (m) s = m[1];
    return s.replace(/^@/, '').toLowerCase();
  }

  function setFormError(msg, field) {
    const el = $('form-error');
    el.textContent = msg || '';
    el.hidden = !msg;
    ['f-nickname', 'f-phone', 'f-line', 'f-ig', 'f-message'].forEach(id => $(id).removeAttribute('aria-invalid'));
    if (field) {
      const input = $('f-' + field);
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    }
  }

  function updateCounter() {
    const n = charLen($('f-nickname').value.trim());
    const c = $('nick-count');
    c.textContent = n + '/' + NICK_MAX;
    c.classList.toggle('over', n > NICK_MAX);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || !state) return;

    const nickname = $('f-nickname').value.replace(/\s+/g, ' ').trim();
    const phone = normalizePhone($('f-phone').value);
    const line = normalizeLineId($('f-line').value);
    const ig = normalizeIg($('f-ig').value);
    const message = $('f-message').value.trim();

    if (charLen(nickname) < 1) return setFormError('請填寫公開暱稱。', 'nickname');
    if (charLen(nickname) > NICK_MAX) return setFormError('暱稱請在 ' + NICK_MAX + ' 個字以內。', 'nickname');
    if (!phone && !line && !ig) return setFormError('請至少填一種聯絡方式（手機、LINE ID 或 IG 帳號）。', 'phone');
    if (phone && !/^09\d{8}$/.test(phone)) return setFormError('手機號碼請填 09 開頭的 10 碼數字。', 'phone');
    if (line && !/^[a-z0-9._-]{4,20}$/.test(line)) {
      return setFormError('這看起來不是 LINE ID。LINE ID 不是顯示名稱，可以到 LINE「主頁 → 設定 → 個人檔案 → ID」查看。', 'line');
    }
    if (ig && !/^[a-z0-9._]{1,30}$/.test(ig)) return setFormError('IG 帳號只能有英文、數字、句點和底線。', 'ig');
    if (charLen(message) > MSG_MAX) return setFormError('給主辦的話請在 ' + MSG_MAX + ' 字以內。', 'message');
    setFormError('');

    submitting = true;
    const btn = $('submit');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '送出中…';

    try {
      const res = await api.post({ nickname, phone, line, ig, message, website: $('f-website').value });
      if (res && res.ok) {
        store.write(state.event.id, { nickname: res.nickname, status: res.status, position: res.position, at: Date.now() });
        success = res;
        view = 'success';
        forceForm = false;
        $('view-form').reset();
        updateCounter();
        renderSuccess(state);
        $('signup').scrollIntoView({ behavior: 'smooth', block: 'start' });
        refresh();
      } else {
        const fieldByError = { nickname: 'nickname', phone: 'phone', line: 'line', ig: 'ig', contact: 'phone', message: 'message' };
        const field = res && (res.error === 'duplicate' ? res.field || 'phone' : fieldByError[res.error]);
        setFormError((res && res.message) || '送出失敗，請稍後再試。', field);
        if (res && ['full', 'deadline', 'closed', 'status'].indexOf(res.error) >= 0) refresh();
      }
    } catch (err) {
      setFormError('送出失敗，請檢查網路後再試一次。如果一直失敗，請直接聯絡主辦。');
    } finally {
      submitting = false;
      btn.disabled = false;
      if (btn.textContent === '送出中…') btn.textContent = label;
    }
  }

  // ── 讀取 event.ics 的時間，用來判斷要不要顯示「Apple／其他」按鈕 ──

  async function loadIcsInfo() {
    try {
      const res = await fetch(ICS_PATH, { cache: 'no-cache' });
      if (!res.ok) return;
      const text = (await res.text()).replace(/\r\n[ \t]/g, '');
      const start = /^DTSTART:(\d{8}T\d{6}Z)\s*$/m.exec(text);
      const end = /^DTEND:(\d{8}T\d{6}Z)\s*$/m.exec(text);
      if (!start || !end) return;
      icsInfo = { start: start[1], end: end[1] };
      if (state) {
        renderInfoCalendar(state.event);
        renderSignup(state);
      }
    } catch (err) {
      /* 讀不到就只顯示 Google 日曆 */
    }
  }

  // ── 載入 ─────────────────────────────────────────

  async function refresh() {
    try {
      const s = await api.get();
      if (!s || !s.ok) throw new Error((s && s.message) || 'bad response');
      state = s;
      renderEvent(s.event);
      renderSeats(s);
      renderSignup(s);
    } catch (err) {
      if (!state) {
        $('error-text').textContent = '請檢查網路後再試一次。';
        $('seats-note').textContent = '暫時讀不到報名狀況';
        show('view-error');
      }
    }
  }

  function bind() {
    $('view-form').addEventListener('submit', onSubmit);
    $('f-nickname').addEventListener('input', updateCounter);
    $('retry').addEventListener('click', () => { show('view-loading'); refresh(); });

    $('roster-toggle').addEventListener('click', () => {
      const t = $('roster-toggle');
      const open = t.getAttribute('aria-expanded') !== 'true';
      t.setAttribute('aria-expanded', String(open));
      $('roster').hidden = !open;
    });

    $('register-another').addEventListener('click', () => {
      forceForm = true;
      renderSignup(state);
      $('f-nickname').focus();
    });

    $('back-to-page').addEventListener('click', () => {
      view = null;
      success = null;
      renderSignup(state);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    document.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const text = document.querySelector('[data-field="' + btn.dataset.copy + '"]').textContent;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = '已複製';
        } catch (err) {
          btn.textContent = text;
        }
        setTimeout(() => { btn.textContent = '複製'; }, 1600);
      });
    });

    setInterval(() => { if (document.visibilityState === 'visible' && !submitting) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state) refresh(); });
  }

  async function init() {
    bind();
    updateCounter();
    if (APPLE_ON) loadIcsInfo();
    if (MOCK) {
      await loadScript('mock-api.js');
      api = window.NightWalkMock(params.get('mock'));
    } else if (cfg.apiUrl) {
      api = realApi(cfg.apiUrl);
    } else {
      $('seats-note').textContent = '報名系統準備中';
      $('view-error').querySelector('.card-h').textContent = '報名即將開放';
      $('error-text').textContent = '報名系統準備中，請稍後再回來看看。';
      $('retry').hidden = true;
      show('view-error');
      return;
    }
    refresh();
  }

  init();
})();
