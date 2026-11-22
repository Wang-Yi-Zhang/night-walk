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
  // App 內建瀏覽器（LINE、Instagram、Facebook）開不了 .ics：點了沒反應，或像 LINE 一樣變成訂閱失敗
  const IN_APP = /\bLine\//.test(navigator.userAgent) ? 'LINE'
    : /\bInstagram\b/.test(navigator.userAgent) ? 'Instagram'
    : /\bFBAN\/|\bFBAV\/|\bFB_IAB\//.test(navigator.userAgent) ? 'Facebook'
    : '';
  // 「Apple／其他」按鈕：config.js 的 appleCalendar，或網址加 ?applecal 單獨測試
  const APPLE_ON = cfg.appleCalendar === true || params.has('applecal');
  // iPhone／iPad（iPadOS 會自稱 Macintosh，用觸控點判斷）
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  // iPhone 的 App 內建瀏覽器用 x-safari-https:// 直接打開 Safari
  // （LINE 2026-11-20 真機實測可行；Instagram、Facebook 還沒實測，失敗時會改成複製連結）
  const SAFARI_JUMP = !!IN_APP && IS_IOS;
  const BROWSER = IS_IOS ? ' Safari ' : '瀏覽器（例如 Chrome）'; // 中英文之間的空格放在這裡
  const SAFARI_WAIT_MS = 1500; // 這段時間內網頁沒轉到背景，就當作沒打開 Safari
  // 防機器人驗證：?mock 時改用 Cloudflare 的測試金鑰（一律通過），本機預覽才不會被網域擋下
  const TURNSTILE_TEST_KEY = '1x00000000000000000000AA';
  const TURNSTILE_KEY = MOCK
    ? (cfg.turnstileSiteKey || params.has('turnstile') ? TURNSTILE_TEST_KEY : '')
    : cfg.turnstileSiteKey || '';
  const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const TOKEN_WAIT_MS = 10000;

  const $ = id => document.getElementById(id);

  let api = null;
  let state = null;
  let prevConfirmed = null;
  let view = null; // 'success' 時停留在成功畫面
  let success = null;
  let forceForm = false;
  let submitting = false;
  let icsInfo = null; // event.ics 的開始／結束時間（UTC），讀不到就是 null
  let icsHint = null; // App 內建瀏覽器裡按過「Apple／其他」後的提示：{ container, copied, fallback }
  const remember = window.NightWalkRemember;
  let prefilled = false; // 這次開啟網頁已經自動帶入過，就不再覆蓋報名者改過的欄位
  let rememberAsk = null; // 成功畫面要問的：'save'、'replace' 或 null
  let rememberDone = ''; // 回答後顯示的一句話
  let submitted = null; // 這次送出的暱稱和聯絡方式（已整理格式），給「記住」用

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

  // ── 防機器人驗證（Cloudflare Turnstile） ────────────────
  // 載入頁面時就在背景取得 token，大多數人不用點任何東西；需要互動時才顯示勾選框。
  // token 只能用一次，每次送出後重新取得。

  const turnstile = {
    id: null,
    token: '',
    waiters: [],
    setToken(t) {
      this.token = t || '';
      if (!this.token) return;
      this.waiters.forEach(fn => fn(this.token));
      this.waiters = [];
    },
    /** 最多等 ms 毫秒；沒啟用或等不到時回傳空字串，交給後端決定。 */
    wait(ms) {
      if (this.id === null || this.token) return Promise.resolve(this.token);
      return new Promise(resolve => {
        const done = t => { clearTimeout(timer); resolve(t); };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter(fn => fn !== done);
          resolve('');
        }, ms);
        this.waiters.push(done);
      });
    },
    reset() {
      this.token = '';
      if (this.id !== null) window.turnstile.reset(this.id);
    },
  };

  async function initTurnstile() {
    const box = $('turnstile-box');
    try {
      await loadScript(TURNSTILE_SRC);
      turnstile.id = window.turnstile.render(box, {
        sitekey: TURNSTILE_KEY,
        language: 'zh-tw',
        appearance: 'interaction-only',
        callback: t => turnstile.setToken(t),
        'expired-callback': () => turnstile.setToken(''),
        'error-callback': () => turnstile.setToken(''),
        'before-interactive-callback': () => box.classList.add('show'),
        'after-interactive-callback': () => box.classList.remove('show'),
      });
    } catch (err) {
      /* 載入失敗（例如被擋廣告的外掛擋下）：照樣送出，由後端決定 */
    }
  }

  // ── 本機記憶（只存在這台裝置的瀏覽器） ───────────────

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
    if (form.hidden) {
      prefillForm();
      show('view-form');
    }
  }

  // ── 在這台裝置的瀏覽器記住我的資料 ─────────────────────────

  /** 有些瀏覽器光是讀 localStorage 就會出錯（例如封鎖 Cookie 時），這時當成沒有記住任何資料。 */
  function storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  const PREFILL_INPUTS = { nickname: 'f-nickname', phone: 'f-phone', line: 'f-line', ig: 'f-ig' };

  /** 自動帶入記住的資料。幫朋友報名時不帶入（帶入自己的資料只會被擋成重複報名）。 */
  function prefillForm() {
    const note = $('prefill-note');
    if (forceForm || prefilled) {
      if (forceForm) note.hidden = true;
      return;
    }
    const rec = remember.read(storage(), Date.now());
    const empty = Object.keys(PREFILL_INPUTS).every(f => !$(PREFILL_INPUTS[f]).value);
    if (!rec || !empty) return;
    Object.keys(PREFILL_INPUTS).forEach(f => { $(PREFILL_INPUTS[f]).value = rec[f]; });
    $('prefill-name').textContent = rec.nickname;
    note.hidden = false;
    prefilled = true;
    updateCounter();
  }

  function clearRemembered() {
    remember.clear(storage());
    Object.keys(PREFILL_INPUTS).forEach(f => { $(PREFILL_INPUTS[f]).value = ''; });
    $('prefill-note').hidden = true;
    updateCounter();
    $('f-nickname').focus();
  }

  function renderRemember() {
    const box = $('remember-box');
    const done = $('remember-done');
    done.textContent = rememberDone;
    done.hidden = !rememberDone;
    box.hidden = !rememberAsk;
    if (!rememberAsk) return;
    const replace = rememberAsk === 'replace';
    $('remember-q').textContent = replace
      ? '這台裝置的瀏覽器記住的是另一份資料，要換成這次填的嗎？'
      : '要在這台裝置的瀏覽器記住你的暱稱和聯絡方式，下次報名自動帶入嗎？';
    const yes = $('remember-yes');
    const no = $('remember-no');
    yes.textContent = replace ? '換成這次的' : '記住';
    // 換掉時預設「不用」（多半是幫朋友報名）；第一次記住時「記住」才是主要按鈕
    yes.classList.toggle('btn-ghost', replace);
    yes.classList.toggle('btn-accent', !replace);
    no.classList.toggle('btn-ghost', !replace);
    no.classList.toggle('btn-accent', replace);
  }

  function answerRemember(keep) {
    if (keep && submitted) remember.save(storage(), submitted, Date.now());
    rememberDone = keep ? '已記住，下次報名會自動帶入。' : '';
    rememberAsk = null;
    renderRemember();
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
    renderRemember();
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
      const iBtn = document.createElement(IN_APP && !SAFARI_JUMP ? 'button' : 'a');
      iBtn.className = 'btn btn-ghost btn-small';
      iBtn.textContent = '🗓 Apple／其他';
      if (SAFARI_JUMP) {
        // 用 x-safari-https:// 叫出 Safari，由報名者在 Safari 的行事曆預覽決定要不要加入。
        // 沒有正式文件、App 也可能擋掉，而且失敗時不會有任何反應，所以沒離開網頁就改成複製連結。
        iBtn.href = icsUrl.replace(/^https:\/\//, 'x-safari-https://');
        iBtn.addEventListener('click', () => {
          let left = false;
          const onHide = () => { if (document.visibilityState === 'hidden') left = true; };
          document.addEventListener('visibilitychange', onHide);
          setTimeout(() => {
            document.removeEventListener('visibilitychange', onHide);
            if (!left) copyIcsLink(container, icsUrl, true);
          }, SAFARI_WAIT_MS);
        });
      } else if (IN_APP) {
        // Android 的 App 內建瀏覽器：沒有 x-safari 可用，改成複製連結，請報名者貼到瀏覽器。
        iBtn.type = 'button';
        iBtn.addEventListener('click', () => copyIcsLink(container, icsUrl, false));
      } else {
        iBtn.href = icsUrl;
      }
      buttons.push(iBtn);
    }
    container.classList.toggle('single', buttons.length === 1);
    container.replaceChildren(...buttons);
    // 每分鐘自動更新會重畫按鈕，提示要保留
    if (icsMatches && IN_APP && icsHint && icsHint.container === container) renderIcsHint(container, icsUrl, false);
  }

  // fallback：試過直接打開 Safari 但沒成功
  // 注意：iOS 只在報名者剛點擊時允許自動複製，1.5 秒後才複製通常會失敗，這時會改成顯示連結讓人自己複製。
  async function copyIcsLink(container, icsUrl, fallback) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(icsUrl);
      copied = true;
    } catch (err) {
      /* 不能自動複製就顯示連結讓報名者自己複製 */
    }
    icsHint = { container, copied, fallback };
    renderIcsHint(container, icsUrl, !copied);
  }

  function renderIcsHint(container, icsUrl, focus) {
    const hint = document.createElement('div');
    hint.className = 'cal-hint';
    const p = document.createElement('p');
    const lead = icsHint.fallback ? '沒有自動打開 Safari 的話：' : IN_APP + ' 裡無法直接加入。';
    p.textContent = icsHint.copied
      ? (icsHint.fallback ? lead + '已複製行事曆連結，' : '已複製行事曆連結。' + lead) + '請打開' + BROWSER.trimEnd() + '，把連結貼到網址列開啟，再按「加入行事曆」。'
      : lead + '請複製下面的連結，打開' + BROWSER + '貼到網址列開啟，再按「加入行事曆」。';
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
      const turnstileToken = await turnstile.wait(TOKEN_WAIT_MS);
      const res = await api.post({ nickname, phone, line, ig, message, website: $('f-website').value, turnstileToken });
      if (res && res.ok) {
        store.write(state.event.id, { nickname: res.nickname, status: res.status, position: res.position, at: Date.now() });
        submitted = { nickname, phone, line, ig };
        rememberAsk = remember.afterSignup(storage(), submitted, Date.now());
        rememberDone = '';
        $('prefill-note').hidden = true;
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
      turnstile.reset();
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
    $('prefill-clear').addEventListener('click', clearRemembered);
    $('remember-yes').addEventListener('click', () => answerRemember(true));
    $('remember-no').addEventListener('click', () => answerRemember(false));
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
    if (TURNSTILE_KEY) initTurnstile();
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
