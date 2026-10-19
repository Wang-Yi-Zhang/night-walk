// 設定檢查：主辦編輯「設定」分頁、執行初始化或選單「檢查設定」時，
// 把常見的填寫錯誤寫在「檢查」欄。只提醒，不改變報名規則。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadBackend, freshEvent, eq } = require('./fake-apps-script');

test('新試算表初始化後有「檢查」欄，而且沒有誤報', () => {
  const h = loadBackend();
  h.setup();
  eq(h.sheet('設定').data[0].slice(0, 4), ['項目', '值', '說明', '檢查']);
  eq(h.checks(), {});
});

test('填好一場正確的活動，不會出現任何提醒', () => {
  const h = freshEvent();
  eq(h.checks(), {});
  h.checkSettings();
  assert.match(h.ui.alerts.at(-1).message, /沒有問題/);
});

test('報名截止少了時間：標示在「檢查」欄並跳出提示，改正後清除', () => {
  const h = freshEvent();
  h.setSetting('報名截止', '2026-11-06');
  assert.match(h.checks()['報名截止'], /少了時間/);
  assert.match(h.toasts.at(-1), /報名截止.*少了時間/);

  h.setSetting('報名截止', '2026-11-06 12:00');
  eq(h.checks(), {});
});

test('各項設定的常見錯誤都有對應的提醒', () => {
  const cases = [
    ['活動日期', '11/6', /2026-11-20/],
    ['活動日期', '2026年11月6日', /2026-11-20/],
    ['活動日期', '2026-02-30', /沒有這一天/],
    ['開始時間', '晚上7點', /19:00/],
    ['開始時間', '7:00 PM', /19:00/],
    ['開始時間', '', /沒有開始時間/],
    ['結束時間', '25:00', /21:00/],
    ['結束時間', '18:00', /晚於開始時間/],
    ['報名截止', '2026/11/06', /少了時間/],
    ['報名截止', '11/6 中午', /2026-11-20 12:00/],
    ['報名截止', '2026-11-07 12:00', /晚於活動開始/],
    ['正取上限', '10人', /讀成 10/],
    ['候補上限', '五', /預設值 5/],
    ['報名開關', 'on', /「開」或「關」/],
    ['活動狀態', '下雨', /停止報名/],
    ['地圖連結', 'http://maps.google.com/', /https/],
    ['聯絡Email', 'hemoparasite', /Email/],
    ['場次代碼', '', /場次代碼/],
  ];
  for (const [key, value, expected] of cases) {
    const h = freshEvent();
    h.setSetting(key, value);
    const checks = h.checks();
    assert.match(checks[key] || '', expected, key + '「' + value + '」');
    eq(Object.keys(checks), [key], key + '「' + value + '」只標示這一項');
  }
});

test('可接受的寫法不會被標示：斜線日期、留空的截止時間和結束時間', () => {
  const h = freshEvent();
  h.setSetting('活動日期', '2026/11/6');
  h.setSetting('報名截止', '2026/11/06 12:00');
  h.setSetting('結束時間', '');
  eq(h.checks(), {});
  h.setSetting('報名截止', '');
  eq(h.checks(), {});
});

test('報名開關「關」時，還沒填的場次代碼和活動日期不算錯', () => {
  const h = freshEvent();
  h.setSetting('報名開關', '關');
  h.setSetting('場次代碼', '');
  h.setSetting('活動日期', '');
  eq(h.checks(), {});
  h.setSetting('報名開關', '開');
  eq(Object.keys(h.checks()).sort(), ['場次代碼', '活動日期'].sort());
});

test('項目名稱打錯、重複或缺少：選單「檢查設定」全部列出', () => {
  const h = freshEvent();
  const data = h.sheet('設定').data;
  data.find(r => r[0] === '候補上限')[0] = '後補上限';
  data.push(['正取上限', '12', '']);

  h.checkSettings();
  const checks = h.checks();
  assert.match(checks['後補上限'], /不認得/);
  assert.match(checks['正取上限'], /重複/);
  const msg = h.ui.alerts.at(-1).message;
  assert.match(msg, /後補上限：不認得/);
  assert.match(msg, /正取上限：重複/);
  assert.match(msg, /候補上限：找不到這個項目/);

  // 重複的項目以最下面那一列為準，跟讀取規則一致
  assert.strictEqual(h.get().capacity, 12);
});

test('提醒不改變報名規則，也不會出現在公開資料裡', () => {
  const h = freshEvent();
  h.setSetting('報名截止', '2026-11-06');
  h.setSetting('正取上限', '10人');
  const st = h.get();
  assert.strictEqual(st.registration.open, true, '截止時間解析不了時照舊不截止');
  assert.strictEqual(st.capacity, 10);
  assert.ok(!JSON.stringify(st).includes('少了時間'));
  assert.ok(!('warnings' in st));
});

test('初始化時有提醒，提示訊息會說有幾項要確認', () => {
  const h = freshEvent();
  h.sheet('設定').data.find(r => r[0] === '報名截止')[1] = '2026-11-06';
  h.setup();
  assert.match(h.checks()['報名截止'], /少了時間/);
  assert.match(h.toasts.at(-1), /1 項設定要確認/);
});

test('編輯「報名」分頁不會觸發設定檢查', () => {
  const h = freshEvent();
  h.sheet('設定').data.find(r => r[0] === '報名截止')[1] = '2026-11-06';
  assert.strictEqual(h.post({ nickname: '甲', phone: '0912345678' }).ok, true);
  h.editSignup('甲', '身分', '取消');
  eq(h.checks(), {});
});
