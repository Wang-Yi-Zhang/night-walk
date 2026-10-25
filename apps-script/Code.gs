/**
 * 麟光夜行報名系統：Google Apps Script 後端
 *
 * 綁定在報名用的 Google 試算表上，部署成「網頁應用程式」後：
 *   GET  → 回傳公開資訊（活動設定、人數、暱稱清單），永遠不含聯絡資料（手機、LINE ID、IG）
 *   POST → 新增一筆報名
 *
 * 權限刻意壓到最小：
 *   - @OnlyCurrentDoc：只能存取「這一份」試算表
 *   - 只用 MailApp 寄信給固定收件人（NOTIFY_EMAIL），不能讀信、不能寄給別人
 *
 * @OnlyCurrentDoc
 */

// ── 固定設定（不放在試算表裡，避免被改成寄給別人） ─────────────────────
const NOTIFY_EMAIL = 'hemoparasite@gmail.com';

const SETTINGS_SHEET = '設定';
const SIGNUP_SHEET = '報名';
// 「報名」分頁的欄位。程式依標題文字找欄位，主辦可以調整順序或插入自己的欄位
const FIELD = {
  time: '報名時間',
  event: '場次代碼',
  nickname: '暱稱',
  phone: '手機',
  line: 'LINE ID',
  ig: 'IG 帳號',
  status: '身分',
  message: '給主辦的話',
};
const SIGNUP_HEADERS = [FIELD.time, FIELD.event, FIELD.nickname, FIELD.phone, FIELD.line, FIELD.ig, FIELD.status, FIELD.message];
const CONTACT_KEYS = ['phone', 'line', 'ig'];
const DELETED = '（已刪除）';

const STATUS_CONFIRMED = '正取';
const STATUS_WAITLIST = '候補';
const STATUS_CANCELLED = '取消';
const EVENT_NORMAL = '正常舉行';
const EVENT_STATUSES = [EVENT_NORMAL, '因雨取消', '延期'];
const CHECK_HEADER = '檢查';
const CHECK_COLOR = '#f8d7da';

const CACHE_KEY = 'public-state-v1';
const CACHE_SECONDS = 30;
const RATE_LIMIT_PER_MINUTE = 20;
const MAX_BODY_LENGTH = 2000;
const NICKNAME_MAX = 12;
const MESSAGE_MAX = 200;

// 試算表「設定」分頁的預設內容：[項目, 值, 說明]
// 只在初始化時補上缺少的項目，不會覆蓋既有值。跟場次有關的項目留空、報名開關預設「關」，
// 所以辦新場次只要改試算表，不用改這裡。
const DEFAULT_SETTINGS = [
  ['場次代碼', '', '每場唯一的代碼，建議用活動日期（例如 2026-11-20）。辦下一場時換一個新的，人數會從 0 開始算'],
  ['活動名稱', '麟光夜行・富陽生態公園', ''],
  ['場次標題', '', '例如「第 2 場」'],
  ['活動日期', '', '格式 YYYY-MM-DD，例如 2026-11-20'],
  ['開始時間', '19:00', '24 小時制 HH:MM'],
  ['結束時間', '21:00', '24 小時制 HH:MM'],
  ['集合地點', '捷運麟光站 1 號出口', ''],
  ['地圖連結', 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('捷運麟光站 1號出口'), ''],
  ['路線', '富陽自然生態公園', ''],
  ['費用', '免費', ''],
  ['正取上限', '10', '加開名額時調高。候補不會自動轉正取，請到「報名」分頁把「候補」改成「正取」'],
  ['候補上限', '5', ''],
  ['報名截止', '', '格式 YYYY-MM-DD HH:MM（台灣時間），例如 2026-11-20 12:00。留空代表不截止'],
  ['報名開關', '關', '「開」或「關」。新試算表預設「關」，填好本場的設定後再改成「開」'],
  ['活動狀態', EVENT_NORMAL, '正常舉行／因雨取消／延期。非「正常舉行」時網頁會顯示橫幅並停止報名'],
  ['狀態補充說明', '', '顯示在橫幅裡，例如「延期至 10/30（五）」'],
  ['攜帶提醒', '手電筒\n長袖長褲\n鞋子（建議雨鞋）\n愉快的心情', '一行一項（儲存格內換行：Ctrl+Enter）'],
  ['雨天規則', '當天 15:00 台北市降雨機率 ≥ 70% 即取消，16:00 前於本頁公告。', ''],
  ['聯絡Email', 'hemoparasite@gmail.com', '公開顯示在網頁上'],
  ['聯絡LINE ID', 'hemoparasite', '公開顯示在網頁上'],
];

// ── 網頁應用程式進入點 ───────────────────────────────────────────────

function doGet() {
  try {
    return json_(getPublicState_());
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server', message: '暫時無法讀取報名狀況，請稍後再試。' });
  }
}

function doPost(e) {
  try {
    const raw = e && e.postData ? String(e.postData.contents || '') : '';
    if (!raw || raw.length > MAX_BODY_LENGTH) return json_(fail_('invalid', '送出的資料格式不正確。'));
    let body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      return json_(fail_('invalid', '送出的資料格式不正確。'));
    }
    return json_(handleSignup_(body || {}));
  } catch (err) {
    console.error(err);
    return json_(fail_('server', '系統發生錯誤，請稍後再試，或直接聯絡主辦。'));
  }
}

// ── 報名 ────────────────────────────────────────────────────────────

function handleSignup_(body) {
  // honeypot：真人看不到這個欄位，有填就是機器人
  if (body.website) return fail_('invalid', '送出失敗，請重新整理頁面再試一次。');

  const nickname = normalizeNickname_(body.nickname);
  const contact = {
    phone: normalizePhone_(body.phone),
    line: normalizeLineId_(body.line),
    ig: normalizeIg_(body.ig),
  };
  const message = normalizeMessage_(body.message);

  const nicknameLength = Array.from(nickname).length;
  if (nicknameLength < 1 || nicknameLength > NICKNAME_MAX) {
    return fail_('nickname', '暱稱請填 1\u2013' + NICKNAME_MAX + ' 個字。');
  }
  if (!contact.phone && !contact.line && !contact.ig) {
    return fail_('contact', '請至少填一種聯絡方式（手機、LINE ID 或 IG 帳號）。');
  }
  if (contact.phone && !/^09\d{8}$/.test(contact.phone)) {
    return fail_('phone', '手機號碼格式不正確，請填 09 開頭的 10 碼數字。');
  }
  if (contact.line && !/^[a-z0-9._-]{4,20}$/.test(contact.line)) {
    return fail_('line', '這看起來不是 LINE ID。LINE ID 不是顯示名稱，可以到 LINE「主頁 → 設定 → 個人檔案 → ID」查看。');
  }
  if (contact.ig && !/^[a-z0-9._]{1,30}$/.test(contact.ig)) {
    return fail_('ig', 'IG 帳號只能有英文、數字、句點和底線。');
  }
  if (Array.from(message).length > MESSAGE_MAX) return fail_('message', '給主辦的話請在 ' + MESSAGE_MAX + ' 字以內。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', '目前報名人數較多，請稍等幾秒再送出一次。');

  let result;
  let settings;
  let counts;
  try {
    if (isRateLimited_()) return fail_('busy', '目前報名人數較多，請稍等一分鐘再送出。');

    const sheet = sheet_(SIGNUP_SHEET);
    ensureSignupColumns_(sheet);
    settings = readSettings_();
    const rows = readSignups_(settings.eventId);
    const active = rows.filter(r => r.status === STATUS_CONFIRMED || r.status === STATUS_WAITLIST);

    const dupKey = findDuplicateContact_(active, contact);
    if (dupKey) {
      const label = { phone: '這支手機', line: '這個 LINE ID ', ig: '這個 IG 帳號' }[dupKey];
      const res = fail_('duplicate', label + '已經報名過本場囉！如需修改或取消，請聯絡主辦。');
      res.field = dupKey;
      return res;
    }

    const nConfirmed = rows.filter(r => r.status === STATUS_CONFIRMED).length;
    const nWaitlist = rows.filter(r => r.status === STATUS_WAITLIST).length;
    const reg = registrationState_(settings, nConfirmed, nWaitlist, new Date());
    if (!reg.open) return fail_(reg.reason, closedMessage_(reg.reason));

    const status = reg.mode;
    const position = status === STATUS_CONFIRMED ? nConfirmed + 1 : nWaitlist + 1;

    // 使用者輸入一律加上 ' 前綴：存成純文字，避免公式注入，也保住手機開頭的 0
    appendSignup_(sheet, {
      time: new Date(),
      event: asText_(settings.eventId),
      nickname: asText_(nickname),
      phone: contact.phone ? asText_(contact.phone) : '',
      line: contact.line ? asText_(contact.line) : '',
      ig: contact.ig ? asText_(contact.ig) : '',
      status: status,
      message: message ? asText_(message) : '',
    });
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(CACHE_KEY);

    counts = {
      confirmed: nConfirmed + (status === STATUS_CONFIRMED ? 1 : 0),
      waitlist: nWaitlist + (status === STATUS_WAITLIST ? 1 : 0),
    };
    result = { ok: true, status: status, position: position, nickname: nickname, capacity: settings.capacity };
  } finally {
    lock.releaseLock();
  }

  notifyOrganizer_(settings, result, contact, message, counts);
  return result;
}

/** 任何一種聯絡方式跟本場已報名的人相同，就回傳那一種（phone／line／ig），否則回傳 null。 */
function findDuplicateContact_(rows, contact) {
  const normalize = { phone: normalizePhone_, line: normalizeLineId_, ig: normalizeIg_ };
  for (const key of CONTACT_KEYS) {
    if (!contact[key]) continue;
    if (rows.some(r => r[key] && normalize[key](r[key]) === contact[key])) return key;
  }
  return null;
}

function notifyOrganizer_(settings, result, contact, message, counts) {
  try {
    const rank = result.status === STATUS_CONFIRMED
      ? '正取 ' + result.position + '/' + settings.capacity
      : '候補 ' + result.position + '/' + settings.waitlistCapacity;
    const subject = '【' + settings.name + '】新報名：' + result.nickname + '（' + rank + '）';
    const body = [
      '暱稱：' + result.nickname,
      '手機：' + (contact.phone || '（未填）'),
      'LINE ID：' + (contact.line || '（未填）'),
      'IG 帳號：' + (contact.ig || '（未填）'),
      '身分：' + rank,
      '給主辦的話：' + (message || '（無）'),
      '',
      '目前正取 ' + counts.confirmed + '/' + settings.capacity + '，候補 ' + counts.waitlist + '/' + settings.waitlistCapacity,
      '場次：' + settings.eventId + ' ' + settings.title,
      '',
      '報名試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    ].join('\n');
    MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, body: body });
  } catch (err) {
    // 寄信失敗（例如超過每日配額）不影響報名本身
    console.error('notify failed', err);
  }
}

// ── 公開資訊 ────────────────────────────────────────────────────────

function getPublicState_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) return JSON.parse(hit);
  const state = buildPublicState_();
  cache.put(CACHE_KEY, JSON.stringify(state), CACHE_SECONDS);
  return state;
}

function buildPublicState_() {
  const s = readSettings_();
  const rows = readSignups_(s.eventId);
  const confirmed = rows.filter(r => r.status === STATUS_CONFIRMED).map(r => r.nickname);
  const waitlist = rows.filter(r => r.status === STATUS_WAITLIST).map(r => r.nickname);
  return {
    ok: true,
    event: {
      id: s.eventId,
      name: s.name,
      title: s.title,
      date: s.date,
      start: s.start,
      end: s.end,
      place: s.place,
      mapUrl: s.mapUrl,
      route: s.route,
      fee: s.fee,
      status: s.status,
      statusNote: s.statusNote,
      bring: s.bring,
      rainRule: s.rainRule,
      contactEmail: s.contactEmail,
      contactLine: s.contactLine,
      deadline: s.deadlineText,
    },
    capacity: s.capacity,
    waitlistCapacity: s.waitlistCapacity,
    confirmed: confirmed,
    waitlist: waitlist,
    registration: registrationState_(s, confirmed.length, waitlist.length, new Date()),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 決定目前能不能報名、報進去是正取還是候補。
 * 只要還有人在候補，新報名一律進候補（空出的名額由主辦手動遞補）。
 */
function registrationState_(s, nConfirmed, nWaitlist, now) {
  if (s.status !== EVENT_NORMAL) return { open: false, mode: null, reason: 'status' };
  if (!s.switchOn) return { open: false, mode: null, reason: 'closed' };
  if (s.deadline && now.getTime() >= s.deadline.getTime()) return { open: false, mode: null, reason: 'deadline' };
  if (nConfirmed < s.capacity && nWaitlist === 0) return { open: true, mode: STATUS_CONFIRMED, reason: null };
  if (nWaitlist < s.waitlistCapacity) return { open: true, mode: STATUS_WAITLIST, reason: null };
  return { open: false, mode: null, reason: 'full' };
}

function closedMessage_(reason) {
  switch (reason) {
    case 'status': return '本場活動目前不開放報名，請看網頁上方的公告。';
    case 'closed': return '報名已關閉。';
    case 'deadline': return '報名已截止。';
    case 'full': return '正取與候補都已額滿，下次請早！';
    default: return '目前無法報名。';
  }
}

// ── 讀取試算表 ──────────────────────────────────────────────────────

function readSettings_() {
  const map = settingsMap_(sheet_(SETTINGS_SHEET).getDataRange().getDisplayValues());
  const get = key => (key in map ? map[key] : '');
  const deadlineText = get('報名截止');
  return {
    eventId: get('場次代碼'),
    name: get('活動名稱'),
    title: get('場次標題'),
    date: get('活動日期'),
    start: get('開始時間'),
    end: get('結束時間'),
    place: get('集合地點'),
    mapUrl: /^https:\/\//.test(get('地圖連結')) ? get('地圖連結') : '',
    route: get('路線'),
    fee: get('費用'),
    capacity: toNonNegativeInt_(get('正取上限'), 10),
    waitlistCapacity: toNonNegativeInt_(get('候補上限'), 5),
    deadlineText: deadlineText,
    deadline: parseTaipeiDateTime_(deadlineText),
    switchOn: get('報名開關') === '開',
    status: get('活動狀態') || EVENT_NORMAL,
    statusNote: get('狀態補充說明'),
    bring: get('攜帶提醒').split(/\r?\n|、/).map(x => x.trim()).filter(Boolean),
    rainRule: get('雨天規則'),
    contactEmail: get('聯絡Email'),
    contactLine: get('聯絡LINE ID'),
  };
}

/** 「設定」分頁的顯示值 → { 項目: 值 }。同一個項目出現兩次時，以最下面那一列為準。 */
function settingsMap_(values) {
  const map = {};
  values.slice(1).forEach(r => {
    const key = String(r[0] || '').trim();
    if (key) map[key] = String(r[1] == null ? '' : r[1]).trim();
  });
  return map;
}

function readSignups_(eventId) {
  const values = sheet_(SIGNUP_SHEET).getDataRange().getDisplayValues();
  const col = columnIndex_(values[0] || []);
  const cell = (r, key) => (col[key] >= 0 ? String(r[col[key]] == null ? '' : r[col[key]]).trim() : '');
  return values.slice(1)
    .filter(r => cell(r, 'event') === eventId && cell(r, 'nickname'))
    .map(r => ({
      nickname: cell(r, 'nickname'),
      phone: cell(r, 'phone'),
      line: cell(r, 'line'),
      ig: cell(r, 'ig'),
      status: cell(r, 'status'),
    }));
}

/** 標題列 → { event: 1, phone: 3, ... }（0 起算），找不到的欄位是 -1。 */
function columnIndex_(headerRow) {
  const headers = headerRow.map(h => String(h == null ? '' : h).trim());
  const col = {};
  Object.keys(FIELD).forEach(key => { col[key] = headers.indexOf(FIELD[key]); });
  return col;
}

function headerRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(h => String(h).trim());
}

/**
 * 補上缺少的欄位：插在 SIGNUP_HEADERS 裡前一個欄位的右邊（例如 LINE ID 插在手機後面），
 * 既有資料整欄往右移，不會錯位。
 */
function ensureSignupColumns_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SIGNUP_HEADERS);
    return;
  }
  SIGNUP_HEADERS.forEach((header, i) => {
    const headers = headerRow_(sheet);
    if (headers.indexOf(header) !== -1) return;
    const prev = i === 0 ? -1 : headers.indexOf(SIGNUP_HEADERS[i - 1]);
    if (i === 0) {
      sheet.insertColumnBefore(1);
      sheet.getRange(1, 1).setValue(header);
    } else if (prev === -1) {
      sheet.getRange(1, headers.length + 1).setValue(header);
    } else {
      sheet.insertColumnAfter(prev + 1);
      sheet.getRange(1, prev + 2).setValue(header);
    }
  });
}

function appendSignup_(sheet, data) {
  const col = columnIndex_(headerRow_(sheet));
  const width = Math.max.apply(null, Object.keys(col).map(k => col[k])) + 1;
  const row = new Array(width).fill('');
  Object.keys(data).forEach(key => {
    if (col[key] >= 0) row[col[key]] = data[key];
  });
  sheet.appendRow(row);
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('找不到「' + name + '」分頁，請先從選單執行「初始化／補齊工作表」。');
  return sh;
}

// ── 輸入整理 ────────────────────────────────────────────────────────

// 控制字元、零寬字元、文字方向覆寫字元
const INVISIBLE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

function normalizeNickname_(v) {
  return String(v == null ? '' : v).replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
}

function normalizePhone_(v) {
  let p = String(v == null ? '' : v).replace(/[\s\-().]/g, '');
  p = p.replace(/^\+?886(?=9)/, '0');
  if (/^9\d{8}$/.test(p)) p = '0' + p; // 試算表把開頭的 0 吃掉時
  return p;
}

/** LINE ID：去掉開頭的 @、轉小寫；貼上 line.me/ti/p/~xxx 加好友網址時取出 ID。 */
function normalizeLineId_(v) {
  let s = String(v == null ? '' : v).replace(INVISIBLE_CHARS, '').trim();
  const m = s.match(/line\.me\/ti\/p\/~([^/?#\s]+)/i);
  if (m) s = m[1];
  return s.replace(/^@/, '').toLowerCase();
}

/** IG 帳號：去掉開頭的 @、轉小寫；貼上 instagram.com/xxx 網址時取出帳號。 */
function normalizeIg_(v) {
  let s = String(v == null ? '' : v).replace(INVISIBLE_CHARS, '').trim();
  const m = s.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) s = m[1];
  return s.replace(/^@/, '').toLowerCase();
}

function normalizeMessage_(v) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, '')
    .trim();
}

function asText_(v) {
  return "'" + v;
}

function toNonNegativeInt_(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? fallback : n;
}

/**
 * 解析 "YYYY-MM-DD HH:MM"（台灣時間），格式不對回傳 null。
 * 沒有這一天（2/30）或時間超出範圍（25:00）也回傳 null，不自動進位，跟設定檢查的判斷一致。
 */
function parseTaipeiDateTime_(text) {
  const m = String(text || '').trim().match(/^(\S+)\s+(\S+)$/);
  const day = m && parseYmd_(m[1]);
  const time = m && parseHm_(m[2]);
  if (!day || !time) return null;
  return new Date(Date.UTC(day.y, day.m - 1, day.d, -8, time.minutes));
}

// ── 設定檢查 ────────────────────────────────────────────────────────

/**
 * 找出「設定」常見的填寫錯誤，回傳 { 項目: 說明 }。
 * 只負責提醒，不改變讀取規則：填錯時程式照舊退回預設行為（例如截止時間解析不了就不截止）。
 */
function settingsWarnings_(map) {
  const get = key => (key in map ? map[key] : '');
  const w = {};
  const switchOn = get('報名開關') === '開';
  const date = parseYmd_(get('活動日期'));
  const start = parseHm_(get('開始時間'));
  const end = parseHm_(get('結束時間'));

  if (!get('場次代碼') && switchOn) w['場次代碼'] = '報名開著，但還沒填場次代碼';

  if (!get('活動日期')) {
    if (switchOn) w['活動日期'] = '報名開著，但還沒填活動日期';
  } else if (date === null) {
    w['活動日期'] = '格式要像 2026-11-20，否則網頁的星期和加入行事曆會失效';
  } else if (!date) {
    w['活動日期'] = '沒有這一天，請確認日期';
  }

  if (!get('開始時間')) w['開始時間'] = '沒有開始時間，加入行事曆會失效';
  else if (!start) w['開始時間'] = '格式要像 19:00（24 小時制），否則加入行事曆會失效';
  if (get('結束時間') && !end) w['結束時間'] = '格式要像 21:00（24 小時制），否則加入行事曆會失效';
  else if (start && end && end.minutes <= start.minutes) w['結束時間'] = '結束時間要晚於開始時間';

  const deadlineText = get('報名截止');
  if (deadlineText) {
    const parts = deadlineText.match(/^(\S+)\s+(\S+)$/);
    const day = parseYmd_(parts ? parts[1] : deadlineText);
    const time = parts ? parseHm_(parts[2]) : null;
    if (!parts && day !== null) w['報名截止'] = '少了時間，報名不會自動截止。請改成像 2026-11-20 12:00 的格式';
    else if (day === null || !time) w['報名截止'] = '格式要像 2026-11-20 12:00，否則報名不會自動截止';
    else if (!day) w['報名截止'] = '沒有這一天，報名不會自動截止。請確認日期';
    else if (date && start && Date.UTC(day.y, day.m - 1, day.d, 0, time.minutes) > Date.UTC(date.y, date.m - 1, date.d, 0, start.minutes)) {
      w['報名截止'] = '截止時間晚於活動開始時間';
    }
  }

  [['正取上限', 10], ['候補上限', 5]].forEach(([key, fallback]) => {
    const v = get(key);
    if (/^\d+$/.test(v)) return;
    const n = parseInt(v, 10);
    w[key] = n >= 0 ? '請只填數字，目前讀成 ' + n : '要填數字，目前退回預設值 ' + fallback;
  });

  if (get('報名開關') !== '開' && get('報名開關') !== '關') w['報名開關'] = '只能填「開」或「關」，目前視為「關」';
  if (get('活動狀態') && EVENT_STATUSES.indexOf(get('活動狀態')) === -1) {
    w['活動狀態'] = '不是下拉選單的選項，網頁會顯示紅色橫幅並停止報名';
  }
  if (get('地圖連結') && !/^https:\/\//.test(get('地圖連結'))) w['地圖連結'] = '要用 https:// 開頭，否則網頁不會顯示地圖連結';
  if (get('聯絡Email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get('聯絡Email'))) w['聯絡Email'] = '看起來不是 Email 地址';
  return w;
}

/** "YYYY-MM-DD"（也接受 /）→ { y, m, d }；格式不對回傳 null，格式對但沒有這一天回傳 false。 */
function parseYmd_(text) {
  const m = String(text || '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y: y, m: mo, d: d } : false;
}

/** "HH:MM"（24 小時制）→ { minutes }；格式不對回傳 null。 */
function parseHm_(text) {
  const m = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  return m && +m[1] < 24 && +m[2] < 60 ? { minutes: +m[1] * 60 + +m[2] } : null;
}

/**
 * 檢查「設定」分頁：每一列的問題寫在「檢查」欄，值的儲存格標成紅色；沒問題的列清空。
 * 回傳 [{ row, key, message }]，row 是試算表列號（缺少的項目沒有列號，row 為 0）。
 */
function checkSettings_() {
  const sh = sheet_(SETTINGS_SHEET);
  const values = sh.getDataRange().getDisplayValues();
  const header = (values[0] || []).map(h => String(h).trim());
  let checkCol = header.indexOf(CHECK_HEADER) + 1;
  if (!checkCol) {
    checkCol = Math.max(header.length, 3) + 1;
    sh.getRange(1, checkCol).setValue(CHECK_HEADER);
  }

  const map = settingsMap_(values);
  const warnings = settingsWarnings_(map);
  const known = DEFAULT_SETTINGS.map(r => r[0]);
  const keys = values.map(r => String(r[0] || '').trim());
  const problems = [];
  const notes = values.slice(1).map((r, i) => {
    const key = keys[i + 1];
    let message = '';
    if (key && known.indexOf(key) === -1) message = '不認得這個項目名稱，程式不會讀取它';
    else if (key && keys.lastIndexOf(key) !== i + 1) message = '重複的項目，程式只讀最下面那一列';
    else if (key) message = warnings[key] || '';
    if (message) problems.push({ row: i + 2, key: key, message: message });
    return message;
  });
  known.forEach(key => {
    if (!(key in map)) problems.push({ row: 0, key: key, message: '找不到這個項目，請從選單執行「初始化／補齊工作表」' });
  });

  if (notes.length) {
    sh.getRange(2, checkCol, notes.length, 1).setValues(notes.map(n => [n ? '⚠️ ' + n : '']));
    sh.getRange(2, 2, notes.length, 1).setBackgrounds(notes.map(n => [n ? CHECK_COLOR : null]));
  }
  return problems;
}

// ── 頻率限制與輸出 ──────────────────────────────────────────────────

/** 全站每分鐘最多 RATE_LIMIT_PER_MINUTE 筆報名請求（在鎖內呼叫）。 */
function isRateLimited_() {
  const cache = CacheService.getScriptCache();
  const key = 'rate-' + Math.floor(Date.now() / 60000);
  const n = parseInt(cache.get(key) || '0', 10);
  if (n >= RATE_LIMIT_PER_MINUTE) return true;
  cache.put(key, String(n + 1), 120);
  return false;
}

function fail_(error, message) {
  return { ok: false, error: error, message: message };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── 試算表選單與管理工具 ─────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔦 夜行報名')
    .addItem('初始化／補齊工作表', 'setup')
    .addItem('立即更新網頁人數', 'clearCache')
    .addItem('檢查設定', 'checkSettings')
    .addSeparator()
    .addItem('清除舊場次的聯絡資料', 'clearOldContacts')
    .addItem('清除所有聯絡資料（含目前場次）', 'clearAllContacts')
    .addToUi();
}

/**
 * 編輯試算表後讓網頁盡快反映（刪除整列不會觸發，最多延遲 30 秒）。
 * 編輯「設定」分頁時順便檢查格式；剛改的那一列有問題就跳出提示。
 */
function onEdit(e) {
  CacheService.getScriptCache().remove(CACHE_KEY);
  try {
    if (!e || !e.range || e.range.getSheet().getName() !== SETTINGS_SHEET) return;
    const row = e.range.getRow();
    const hit = checkSettings_().filter(p => p.row === row)[0];
    if (hit) toast_('「' + hit.key + '」' + hit.message);
  } catch (err) {
    console.error('check settings failed', err);
  }
}

function clearCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
  toast_('網頁人數已更新。');
}

function checkSettings() {
  const problems = checkSettings_();
  const ui = SpreadsheetApp.getUi();
  if (!problems.length) {
    ui.alert('檢查設定', '設定看起來沒有問題。', ui.ButtonSet.OK);
    return;
  }
  const lines = problems.map(p => '・' + p.key + '：' + p.message);
  ui.alert('檢查設定', '有 ' + problems.length + ' 個地方要確認（也標在「設定」分頁的「' + CHECK_HEADER + '」欄）：\n\n' + lines.join('\n'), ui.ButtonSet.OK);
}

/**
 * 建立或補齊「設定」與「報名」分頁。可重複執行：已存在的設定值不會被覆蓋。
 * 第一次部署時從 Apps Script 編輯器執行這個函式，順便完成授權。
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let settings = ss.getSheetByName(SETTINGS_SHEET);
  if (!settings) settings = ss.insertSheet(SETTINGS_SHEET, 0);
  if (settings.getLastRow() === 0) settings.appendRow(['項目', '值', '說明']);
  const existingKeys = settings.getDataRange().getDisplayValues().slice(1).map(r => String(r[0]).trim());
  settings.getRange('B:B').setNumberFormat('@');
  DEFAULT_SETTINGS.forEach(([key, value, note]) => {
    if (existingKeys.indexOf(key) === -1) settings.appendRow([key, value, note]);
  });
  const problems = checkSettings_();
  const checkCol = headerRow_(settings).indexOf(CHECK_HEADER) + 1;
  settings.setFrozenRows(1);
  settings.getRange(1, 1, 1, settings.getLastColumn()).setFontWeight('bold').setBackground('#1d2742').setFontColor('#ffffff');
  settings.setColumnWidth(1, 130);
  settings.setColumnWidth(2, 320);
  settings.setColumnWidth(3, 420);
  settings.setColumnWidth(checkCol, 280);
  settings.getRange(2, checkCol, settings.getMaxRows() - 1, 1).setWrap(true).setFontColor('#b3261e');
  settings.getRange('B:C').setWrap(true);
  settings.getRange('A:D').setVerticalAlignment('top');
  setDropdown_(settings, '報名開關', ['開', '關']);
  setDropdown_(settings, '活動狀態', EVENT_STATUSES);

  let signups = ss.getSheetByName(SIGNUP_SHEET);
  if (!signups) signups = ss.insertSheet(SIGNUP_SHEET, 1);
  ensureSignupColumns_(signups);
  const col = columnIndex_(headerRow_(signups));
  const column = key => signups.getRange(1, col[key] + 1, signups.getMaxRows(), 1);
  signups.setFrozenRows(1);
  signups.getRange(1, 1, 1, signups.getLastColumn()).setFontWeight('bold').setBackground('#1d2742').setFontColor('#ffffff');
  ['event', 'nickname', 'phone', 'line', 'ig'].forEach(key => column(key).setNumberFormat('@'));
  column('message').setNumberFormat('@').setWrap(true);
  signups.setColumnWidth(col.time + 1, 150);
  signups.setColumnWidth(col.message + 1, 320);
  signups.getRange(2, col.status + 1, Math.max(signups.getMaxRows() - 1, 1), 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList([STATUS_CONFIRMED, STATUS_WAITLIST, STATUS_CANCELLED], true)
      .setAllowInvalid(true)
      .build()
  );

  const sheet1 = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 2) ss.deleteSheet(sheet1);

  CacheService.getScriptCache().remove(CACHE_KEY);
  toast_('「設定」與「報名」分頁已就緒。' + (problems.length ? '有 ' + problems.length + ' 項設定要確認，請看「' + CHECK_HEADER + '」欄。' : ''));
}

function setDropdown_(sheet, key, options) {
  const keys = sheet.getDataRange().getDisplayValues().map(r => String(r[0]).trim());
  const row = keys.indexOf(key) + 1;
  if (row < 1) return;
  sheet.getRange(row, 2).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(options, true).setAllowInvalid(false).build()
  );
}

function clearOldContacts() {
  clearContacts_(false);
}

function clearAllContacts() {
  clearContacts_(true);
}

/** 把手機、LINE ID、IG 帳號改成「（已刪除）」，暱稱與報名紀錄保留。 */
function clearContacts_(includeCurrent) {
  const ui = SpreadsheetApp.getUi();
  const currentId = readSettings_().eventId;
  const scope = includeCurrent ? '所有場次（包含目前場次）' : '目前場次（' + currentId + '）以外的舊場次';
  const answer = ui.alert('清除聯絡資料', '將把' + scope + '的手機、LINE ID、IG 帳號改成「' + DELETED + '」，無法復原。確定嗎？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  const sh = sheet_(SIGNUP_SHEET);
  const values = sh.getDataRange().getDisplayValues();
  const col = columnIndex_(values[0] || []);
  let cleared = 0;
  for (let i = 1; i < values.length; i++) {
    if (!includeCurrent && String(values[i][col.event]).trim() === currentId) continue;
    let touched = false;
    CONTACT_KEYS.forEach(key => {
      if (col[key] < 0) return;
      const v = String(values[i][col[key]]).trim();
      if (!v || v === DELETED) return;
      sh.getRange(i + 1, col[key] + 1).setValue(DELETED);
      touched = true;
    });
    if (touched) cleared++;
  }
  ui.alert('完成', '已清除 ' + cleared + ' 筆報名的聯絡資料。', ui.ButtonSet.OK);
}

function toast_(msg) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, '夜行報名', 5);
  } catch (err) {
    console.log(msg);
  }
}
