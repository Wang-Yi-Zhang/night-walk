// 在 Node 裡載入 apps-script/Code.gs，用記憶體裡的假服務取代 Google 的
// 試算表、快取、鎖、寄信和輸出服務。測試只透過對外介面操作：
//   doGet、doPost、setup、checkSettings、clearOldContacts、clearAllContacts、onEdit
// 再檢查回傳的 JSON，以及主辦者在試算表上看到的「顯示值」。
//
// 注意：Code.gs 跑在另一個 vm realm 裡，那邊產生的陣列跟這邊的 Array 不是同一個，
// 比較陣列時請用 eq()（比 JSON 字串），不要用 deepStrictEqual。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

// 突變檢查時設定 CODE_GS_PATH 指向改壞的複本，repo 裡的 Code.gs 保持不動
const DEFAULT_CODE_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');

/**
 * freshEvent() 的測試活動。跟 Code.gs 的預設值無關：預設值是「全新試算表長什麼樣」，
 * 由 setup.test.js 驗證；報名規則的測試一律在這場活動上跑。
 */
const TEST_EVENT = {
  '場次代碼': '2026-11-06',
  '場次標題': '測試場',
  '活動日期': '2026-11-06',
  '報名截止': '2026-11-06 12:00',
  '報名開關': '開',
  '活動狀態': '正常舉行',
  '正取上限': '10',
  '候補上限': '5',
};

/** 預設時間：2026-11-01 08:00 台灣時間，在測試活動的截止時間之前。 */
const DEFAULT_NOW = Date.UTC(2026, 10, 1, 0, 0);

const HEADERS = ['報名時間', '場次代碼', '暱稱', '手機', 'LINE ID', 'IG 帳號', '身分', '給主辦的話'];

const eq = (actual, expected, message) =>
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);

/** 依「1 → 0900000001」產生不重複的手機號碼。 */
const phone = i => '09' + String(i).padStart(8, '0');

/** 回傳自己的萬用物件：用來吸收格式設定這類測試不在意的呼叫（setFontWeight、setWrap…）。 */
function chain() {
  const p = new Proxy(function () {}, {
    get: (t, k) => (k === 'build' ? () => ({}) : () => p),
    apply: () => p,
  });
  return p;
}

/** 儲存格的顯示值：' 前綴不顯示，日期顯示成 ISO 字串。 */
function display(v) {
  if (v instanceof Date) return v.toISOString();
  if (v == null) return '';
  const s = String(v);
  return s.startsWith("'") ? s.slice(1) : s;
}

function makeSheet(name) {
  const sh = {
    name,
    data: [],
    width() { return sh.data.reduce((m, r) => Math.max(m, r.length), 0); },
    appendRow(arr) { sh.data.push(Array.from(arr)); return sh; },
    getLastRow() { return sh.data.length; },
    getLastColumn() { return sh.width(); },
    getMaxRows() { return 1000; },
    insertColumnAfter(c) { sh.data.forEach(r => { while (r.length < c) r.push(''); r.splice(c, 0, ''); }); return sh; },
    insertColumnBefore(c) { sh.data.forEach(r => r.splice(c - 1, 0, '')); return sh; },
    getDataRange() {
      return {
        getDisplayValues: () => {
          const w = sh.width();
          return sh.data.map(r => Array.from({ length: w }, (_, i) => display(r[i])));
        },
      };
    },
    getRange(row, col, numRows, numCols) {
      if (typeof row !== 'number') return chain(); // 例如 getRange('B:B') 只用來設定格式
      const rest = chain();
      return new Proxy({}, {
        get: (t, k) => {
          if (k === 'setValue') {
            return v => {
              while (sh.data.length < row) sh.data.push([]);
              const r = sh.data[row - 1];
              while (r.length < col) r.push('');
              r[col - 1] = v;
              return rest;
            };
          }
          if (k === 'setValues') {
            return values => {
              values.forEach((vals, i) => {
                while (sh.data.length < row + i) sh.data.push([]);
                const r = sh.data[row - 1 + i];
                while (r.length < col - 1 + vals.length) r.push('');
                vals.forEach((v, j) => { r[col - 1 + j] = v; });
              });
              return rest;
            };
          }
          if (k === 'getDisplayValues') {
            return () => sh.data.slice(row - 1, row - 1 + (numRows || 1))
              .map(r => Array.from({ length: numCols || 1 }, (_, i) => display(r[col - 1 + i])));
          }
          return () => rest;
        },
      });
    },
    setFrozenRows() {},
    setColumnWidth() {},
  };
  return sh;
}

/**
 * 載入一份全新的後端。
 * 選項：
 *   now     起始時間（毫秒），預設 DEFAULT_NOW
 *   tickMs  每次 post() 之後時鐘前進多少，預設 5 秒（模擬真實請求間隔，不會撞到每分鐘 20 筆的限制）
 *   sheets  起始分頁名稱，預設是新試算表的「工作表1」
 *   scriptProperties  起始的指令碼屬性，例如 { TURNSTILE_SECRET: 'secret' }；預設沒有
 */
function loadBackend(options = {}) {
  const clock = { now: options.now ?? DEFAULT_NOW };
  const tickMs = options.tickMs ?? 5000;

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  }

  const sheets = (options.sheets ?? ['工作表1']).map(makeSheet);
  const spreadsheet = {
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: (n, i) => { const s = makeSheet(n); sheets.splice(i ?? sheets.length, 0, s); return s; },
    getSheets: () => sheets,
    deleteSheet: s => { sheets.splice(sheets.indexOf(s), 1); },
    getUrl: () => 'https://docs.google.com/spreadsheets/d/TEST',
    toast: msg => { toasts.push(String(msg)); },
  };
  const toasts = [];

  const cacheStore = new Map(); // key → { value, expires }
  const cache = {
    get: k => {
      const hit = cacheStore.get(k);
      if (!hit) return null;
      if (clock.now >= hit.expires) { cacheStore.delete(k); return null; }
      return hit.value;
    },
    put: (k, v, seconds) => { cacheStore.set(k, { value: String(v), expires: clock.now + (seconds ?? 600) * 1000 }); },
    remove: k => { cacheStore.delete(k); },
  };

  const lock = { available: true, held: false };
  const mail = { sent: [], fail: false };
  // 指令碼屬性（例如 TURNSTILE_SECRET）
  const props = new Map(Object.entries(options.scriptProperties ?? {}));
  // 對外連線：預設模擬 Cloudflare，token 是 'pass' 才通過。測試可以換掉 respond：
  // 回傳 { code, body }（body 是物件時轉成 JSON），丟出錯誤代表連不上
  const fetches = {
    calls: [],
    respond: (url, params) => ({ code: 200, body: { success: params.payload.response === 'pass' } }),
  };
  const ui = { answer: 'YES', alerts: [] };
  const logs = [];

  const ctx = {
    Date: FakeDate,
    console: {
      log: (...a) => logs.push(['log', ...a]),
      error: (...a) => logs.push(['error', ...a]),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush: () => {},
      newDataValidation: () => chain(),
      getUi: () => ({
        alert: (title, message, buttons) => { ui.alerts.push({ title, message }); return buttons === 'YES_NO' ? ui.answer : 'OK'; },
        Button: { YES: 'YES', NO: 'NO', OK: 'OK' },
        ButtonSet: { YES_NO: 'YES_NO', OK: 'OK' },
        createMenu: () => chain(),
      }),
    },
    CacheService: { getScriptCache: () => cache },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (!lock.available || lock.held) return false; lock.held = true; return true; },
        releaseLock: () => { lock.held = false; },
      }),
    },
    MailApp: {
      sendEmail: m => {
        if (mail.fail) throw new Error('Service invoked too many times for one day: email.');
        mail.sent.push(m);
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: k => (props.has(k) ? props.get(k) : null) }),
    },
    UrlFetchApp: {
      fetch: (url, params) => {
        fetches.calls.push({ url, params });
        const r = fetches.respond(url, params);
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return { getResponseCode: () => r.code, getContentText: () => text };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({
        text,
        mimeType: null,
        setMimeType(t) { this.mimeType = t; return this; },
      }),
    },
  };
  vm.createContext(ctx);
  const codePath = process.env.CODE_GS_PATH || DEFAULT_CODE_PATH;
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx, { filename: codePath });

  /** 模擬主辦編輯某個分頁的第 row 列（觸發 onEdit 簡易觸發條件）。 */
  const edit = (sheetName, row) => ctx.onEdit({ range: { getSheet: () => ({ getName: () => sheetName }), getRow: () => row } });

  const parse = out => {
    assert.strictEqual(out.mimeType, 'application/json');
    return JSON.parse(out.text);
  };

  const sheet = name => spreadsheet.getSheetByName(name);
  const signupSheet = () => sheet('報名');
  const header = () => signupSheet().data[0].map(display);
  /** 「報名」分頁的每一列（不含標題），以標題文字為鍵的顯示值。 */
  const rows = () => {
    const h = header();
    return signupSheet().data.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, display(r[i])])));
  };
  const findIndex = nickname => {
    const col = header().indexOf('暱稱');
    const i = signupSheet().data.findIndex((r, idx) => idx > 0 && display(r[col]) === nickname);
    assert.ok(i > 0, '找不到暱稱「' + nickname + '」');
    return i;
  };

  const h = {
    ctx,
    clock,
    lock,
    mail,
    props,
    fetches,
    ui,
    logs,
    toasts,
    spreadsheet,
    sheets,
    sheet,
    header,
    rows,
    /** 某個暱稱那一列的顯示值；找不到時回傳 undefined。 */
    rowOf: nickname => rows().find(r => r['暱稱'] === nickname),
    /** 原始儲存格內容（含 ' 前綴），用來確認存成純文字。 */
    rawOf: nickname => {
      const r = signupSheet().data[findIndex(nickname)];
      return Object.fromEntries(header().map((k, i) => [k, r[i]]));
    },

    // ── 對外介面 ──
    get: () => parse(ctx.doGet()),
    post: body => {
      const res = h.postRaw(JSON.stringify(body));
      clock.now += tickMs;
      return res;
    },
    postRaw: contents => parse(ctx.doPost(contents === undefined ? undefined : { postData: { contents } })),
    setup: () => ctx.setup(),
    checkSettings: () => ctx.checkSettings(),
    clearOldContacts: () => ctx.clearOldContacts(),
    clearAllContacts: () => ctx.clearAllContacts(),

    // ── 主辦者在試算表上的操作 ──
    // 編輯儲存格會觸發 onEdit（清除快取、檢查設定）；刪除整列不會，跟真的試算表一樣。
    setSetting: (key, value) => {
      const data = sheet('設定').data;
      const i = data.map(row => display(row[0])).lastIndexOf(key);
      assert.ok(i > 0, '「設定」沒有「' + key + '」');
      data[i][1] = value;
      edit('設定', i + 1);
    },
    /** 「設定」分頁「檢查」欄的內容：{ 項目: 顯示值 }，只列出有內容的列。 */
    checks: () => {
      const data = sheet('設定').data;
      const col = data[0].map(display).indexOf('檢查');
      assert.ok(col >= 0, '「設定」沒有「檢查」欄');
      const out = {};
      data.slice(1).forEach(r => { if (display(r[col])) out[display(r[0])] = display(r[col]); });
      return out;
    },
    editSignup: (nickname, field, value) => {
      const col = header().indexOf(field);
      assert.ok(col >= 0, '「報名」沒有「' + field + '」欄');
      const i = findIndex(nickname);
      signupSheet().data[i][col] = value;
      edit('報名', i + 1);
    },
    deleteSignupRow: nickname => { signupSheet().data.splice(findIndex(nickname), 1); },
    advance: ms => { clock.now += ms; },
  };
  return h;
}

/** 從空白試算表初始化，再由主辦填好 TEST_EVENT 的一場活動（正取 10、候補 5、截止 2026-11-06 12:00）。 */
function freshEvent(options) {
  const h = loadBackend(options);
  h.setup();
  Object.keys(TEST_EVENT).forEach(key => h.setSetting(key, TEST_EVENT[key]));
  return h;
}

module.exports = { loadBackend, freshEvent, eq, phone, display, HEADERS, DEFAULT_NOW, TEST_EVENT };
