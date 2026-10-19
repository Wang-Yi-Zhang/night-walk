// 試算表選單「初始化／補齊工作表」（setup）與欄位自動搬移。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadBackend, freshEvent, eq, HEADERS } = require('./fake-apps-script');

test('從空白試算表初始化：建立「設定」「報名」，移除空的「工作表1」', () => {
  const h = loadBackend();
  h.setup();
  eq(h.sheets.map(s => s.name), ['設定', '報名']);
  eq(h.header(), HEADERS);
  const keys = h.sheet('設定').data.slice(1).map(r => r[0]);
  assert.strictEqual(keys.length, 20);
  assert.ok(keys.includes('場次代碼') && keys.includes('報名截止') && keys.includes('聯絡LINE ID'));
});

test('全新試算表初始化後不開放報名：跟場次有關的設定留空，報名開關是「關」', () => {
  const h = loadBackend();
  h.setup();
  const setting = key => h.sheet('設定').data.find(r => r[0] === key)[1];
  ['場次代碼', '場次標題', '活動日期', '報名截止'].forEach(key => assert.strictEqual(setting(key), '', key));
  assert.strictEqual(setting('報名開關'), '關');

  const st = h.get();
  eq(st.registration, { open: false, mode: null, reason: 'closed' });
  const r = h.post({ nickname: '太早', phone: '0912345678' });
  assert.strictEqual(r.error, 'closed');
  assert.strictEqual(h.rows().length, 0);
});

test('重複初始化不會產生重複的設定或欄位，也不覆蓋主辦改過的設定值', () => {
  const h = freshEvent();
  h.setSetting('正取上限', '12');
  h.setup();
  h.setup();
  assert.strictEqual(h.sheet('設定').data.length, 21);
  eq(h.header(), HEADERS);
  assert.strictEqual(h.get().capacity, 12);
});

test('設定少了某一項時，初始化只補上缺少的項目', () => {
  const h = freshEvent();
  const data = h.sheet('設定').data;
  data.splice(data.findIndex(r => r[0] === '候補上限'), 1);
  h.setup();
  const keys = data.slice(1).map(r => r[0]);
  assert.strictEqual(keys.filter(k => k === '候補上限').length, 1);
  assert.strictEqual(keys.length, 20);
});

test('「工作表1」裡有資料時不刪除', () => {
  const h = loadBackend();
  h.sheet('工作表1').appendRow(['主辦的筆記']);
  h.setup();
  eq(h.sheets.map(s => s.name), ['設定', '報名', '工作表1']);
});

test('舊版 6 欄試算表：舊格式能讀，初始化後變 8 欄且資料不錯位', () => {
  const h = freshEvent();
  h.sheet('報名').data = [
    ['報名時間', '場次代碼', '暱稱', '手機', '身分', '給主辦的話'],
    [new Date(), "'2026-10-23", "'老朋友", "'0911111111", '正取', "'第一次"],
    [new Date(), "'2026-10-23", "'候補甲", "'0922222222", '候補', ''],
  ];
  h.setSetting('場次代碼', '2026-10-23');

  let st = h.get();
  eq(st.confirmed, ['老朋友']);
  eq(st.waitlist, ['候補甲']);

  h.setup();
  eq(h.header(), HEADERS);
  const old = h.rowOf('老朋友');
  assert.strictEqual(old['手機'], '0911111111');
  assert.strictEqual(old['LINE ID'], '');
  assert.strictEqual(old['IG 帳號'], '');
  assert.strictEqual(old['身分'], '正取');
  assert.strictEqual(old['給主辦的話'], '第一次');
  assert.strictEqual(h.rowOf('候補甲')['身分'], '候補');

  h.setup();
  eq(h.header(), HEADERS);
  st = h.get();
  eq(st.confirmed, ['老朋友']);
  eq(st.waitlist, ['候補甲']);
});

test('舊版 6 欄試算表沒先初始化，第一筆新報名也會自動補欄位再寫入', () => {
  const h = freshEvent();
  h.sheet('報名').data = [
    ['報名時間', '場次代碼', '暱稱', '手機', '身分', '給主辦的話'],
    [new Date(), "'2026-11-06", "'老朋友", "'0911111111", '正取', ''],
  ];
  const r = h.post({ nickname: '新朋友', line: 'new_friend' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  eq(h.header(), HEADERS);
  assert.strictEqual(h.rowOf('新朋友')['LINE ID'], 'new_friend');
  assert.strictEqual(h.rowOf('老朋友')['手機'], '0911111111');
});

test('還沒初始化就讀取或報名：回傳 server 錯誤，不會丟出例外', () => {
  const h = loadBackend();
  const st = h.get();
  assert.strictEqual(st.ok, false);
  assert.strictEqual(st.error, 'server');
  const r = h.post({ nickname: '早鳥', phone: '0912345678' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'server');
  assert.strictEqual(h.lock.held, false, '出錯也要釋放鎖');
});
