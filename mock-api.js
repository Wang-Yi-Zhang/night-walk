// 本機預覽用的假後端（網址加 ?mock 才會載入），規則與 apps-script/Code.gs 相同。
window.NightWalkMock = function (scenario) {
  'use strict';

  const settings = {
    id: '2026-10-26',
    name: '麟光夜行・富陽生態公園',
    title: '第 1 場',
    date: '2026-10-26',
    start: '19:00',
    end: '21:00',
    place: '捷運麟光站 1 號出口',
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('捷運麟光站 1號出口'),
    route: '富陽自然生態公園',
    fee: '免費',
    status: '正常舉行',
    statusNote: '',
    bring: ['手電筒', '長袖長褲', '鞋子（建議雨鞋）', '愉快的心情'],
    rainRule: '當天 15:00 台北市降雨機率 ≥ 70% 即取消，16:00 前於本頁公告。',
    contactEmail: 'hemoparasite@gmail.com',
    contactLine: 'hemoparasite',
    deadline: '2026-10-26 12:00',
  };
  let capacity = 10;
  const waitlistCapacity = 5;
  let deadlinePassed = false;

  const names = ['青蛙王子', '阿螢', 'Moth', '小鴞', '夜貓子', '蟬蛻收藏家', '樹蛙控', '小明', '竹節蟲', 'Amy', '蝸牛慢慢', '黑眶蟾蜍', '螳螂', '蜘蛛人', '月光'];
  const rows = [];
  const seed = (n, status) => { for (let i = 0; i < n; i++) rows.push({ nickname: names[rows.length], phone: '09000000' + String(rows.length).padStart(2, '0'), line: 'mock_line_' + rows.length, ig: '', status }); };

  switch (scenario) {
    case 'empty': break;
    case 'wait': seed(10, '正取'); seed(2, '候補'); break;
    case 'hold': seed(9, '正取'); seed(2, '候補'); break;
    case 'full': seed(10, '正取'); seed(5, '候補'); break;
    case 'rain': seed(8, '正取'); settings.status = '因雨取消'; settings.statusNote = '15:00 降雨機率 80%，本場取消，改期另行通知。'; break;
    case 'deadline': seed(7, '正取'); deadlinePassed = true; break;
    case 'notice': seed(3, '正取'); settings.statusNote = '原訂 10/23（五）因颱風改期至 10/26（一），時間地點不變。'; break;
    default: seed(6, '正取');
  }

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const count = st => rows.filter(r => r.status === st).length;

  function registration() {
    if (settings.status !== '正常舉行') return { open: false, mode: null, reason: 'status' };
    if (deadlinePassed) return { open: false, mode: null, reason: 'deadline' };
    const c = count('正取');
    const w = count('候補');
    if (c < capacity && w === 0) return { open: true, mode: '正取', reason: null };
    if (w < waitlistCapacity) return { open: true, mode: '候補', reason: null };
    return { open: false, mode: null, reason: 'full' };
  }

  function state() {
    return {
      ok: true,
      event: Object.assign({}, settings),
      capacity,
      waitlistCapacity,
      confirmed: rows.filter(r => r.status === '正取').map(r => r.nickname),
      waitlist: rows.filter(r => r.status === '候補').map(r => r.nickname),
      registration: registration(),
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    async get() {
      await delay(400);
      return state();
    },
    async post(body) {
      await delay(700);
      if (body.website) return { ok: false, error: 'invalid', message: '送出失敗，請重新整理頁面再試一次。' };
      const nickname = String(body.nickname || '').replace(/\s+/g, ' ').trim();
      const contact = { phone: String(body.phone || ''), line: String(body.line || ''), ig: String(body.ig || '') };
      const len = Array.from(nickname).length;
      if (len < 1 || len > 12) return { ok: false, error: 'nickname', message: '暱稱請填 1–12 個字。' };
      if (!contact.phone && !contact.line && !contact.ig) return { ok: false, error: 'contact', message: '請至少填一種聯絡方式（手機、LINE ID 或 IG 帳號）。' };
      if (contact.phone && !/^09\d{8}$/.test(contact.phone)) return { ok: false, error: 'phone', message: '手機號碼格式不正確，請填 09 開頭的 10 碼數字。' };
      if (contact.line && !/^[a-z0-9._-]{4,20}$/.test(contact.line)) return { ok: false, error: 'line', message: '這看起來不是 LINE ID。' };
      if (contact.ig && !/^[a-z0-9._]{1,30}$/.test(contact.ig)) return { ok: false, error: 'ig', message: 'IG 帳號只能有英文、數字、句點和底線。' };
      const labels = { phone: '這支手機', line: '這個 LINE ID ', ig: '這個 IG 帳號' };
      for (const key of ['phone', 'line', 'ig']) {
        if (contact[key] && rows.some(r => r[key] === contact[key])) {
          return { ok: false, error: 'duplicate', field: key, message: labels[key] + '已經報名過本場囉！如需修改或取消，請聯絡主辦。' };
        }
      }
      const reg = registration();
      if (!reg.open) return { ok: false, error: reg.reason, message: '目前無法報名。' };
      const position = count(reg.mode) + 1;
      rows.push(Object.assign({ nickname, status: reg.mode }, contact));
      return { ok: true, status: reg.mode, position, nickname, capacity };
    },
  };
};
