// 通知信，以及試算表選單的「清除舊場次／所有聯絡資料」。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshEvent, phone } = require('./fake-apps-script');

test('通知信只寄給固定收件人，內容含三種聯絡方式，沒填的標「（未填）」', () => {
  const h = freshEvent();
  h.post({ nickname: '螢火蟲', line: '@Frog.King_1', message: '第一次參加' });
  assert.strictEqual(h.mail.sent.length, 1);
  const m = h.mail.sent[0];
  assert.strictEqual(m.to, 'hemoparasite@gmail.com');
  assert.ok(m.subject.includes('麟光夜行・富陽生態公園'), m.subject);
  assert.ok(m.subject.includes('螢火蟲'), m.subject);
  assert.ok(m.subject.includes('正取 1/10'), m.subject);
  ['暱稱：螢火蟲', '手機：（未填）', 'LINE ID：frog.king_1', 'IG 帳號：（未填）', '給主辦的話：第一次參加',
    '目前正取 1/10，候補 0/5', '場次：2026-10-23 第 1 場', 'https://docs.google.com/spreadsheets/d/TEST']
    .forEach(s => assert.ok(m.body.includes(s), '信件缺少「' + s + '」：\n' + m.body));
});

test('候補的通知信標出候補順位；沒留話時寫「（無）」', () => {
  const h = freshEvent();
  h.setSetting('正取上限', '1');
  h.post({ nickname: '甲', phone: phone(1) });
  h.post({ nickname: '乙', phone: phone(2), ig: 'yi.tw' });
  const m = h.mail.sent[1];
  assert.ok(m.subject.includes('候補 1/5'), m.subject);
  assert.ok(m.body.includes('手機：' + phone(2)));
  assert.ok(m.body.includes('IG 帳號：yi.tw'));
  assert.ok(m.body.includes('給主辦的話：（無）'));
  assert.ok(m.body.includes('目前正取 1/1，候補 1/5'));
});

test('失敗的報名不寄信', () => {
  const h = freshEvent();
  h.post({ nickname: '', phone: phone(1) });
  h.post({ nickname: '甲', phone: phone(1) });
  h.post({ nickname: '乙', phone: phone(1) });
  assert.strictEqual(h.mail.sent.length, 1);
});

test('寄信失敗（例如超過每日配額）不影響報名結果', () => {
  const h = freshEvent();
  h.mail.fail = true;
  const r = h.post({ nickname: '沒收到信', phone: phone(1) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.status, '正取');
  assert.strictEqual(h.rowOf('沒收到信')['身分'], '正取');
  assert.strictEqual(h.get().confirmed.length, 1);
});

/** 目前場次報兩筆，再放一筆舊場次的資料。 */
function withOldEvent() {
  const h = freshEvent();
  h.post({ nickname: '螢火蟲', line: 'frog.king_1' });
  h.post({ nickname: '全都要', phone: phone(2), line: 'all_in', ig: 'all.in' });
  h.sheet('報名').appendRow([new Date(), "'2026-09-01", "'舊場次", "'0911111111", "'old_line", "'old.ig", '正取', "'上次很好玩"]);
  h.sheet('報名').appendRow([new Date(), "'2026-09-01", "'舊只有IG", '', '', "'only.ig", '取消', '']);
  return h;
}

test('清除舊場次的聯絡資料：只動舊場次，暱稱與紀錄保留', () => {
  const h = withOldEvent();
  h.clearOldContacts();

  const old = h.rowOf('舊場次');
  assert.strictEqual(old['手機'], '（已刪除）');
  assert.strictEqual(old['LINE ID'], '（已刪除）');
  assert.strictEqual(old['IG 帳號'], '（已刪除）');
  assert.strictEqual(old['暱稱'], '舊場次');
  assert.strictEqual(old['身分'], '正取');
  assert.strictEqual(old['給主辦的話'], '上次很好玩');
  const igOnly = h.rowOf('舊只有IG');
  assert.strictEqual(igOnly['手機'], '', '空白欄位維持空白');
  assert.strictEqual(igOnly['IG 帳號'], '（已刪除）');

  assert.strictEqual(h.rowOf('螢火蟲')['LINE ID'], 'frog.king_1', '目前場次不動');
  assert.strictEqual(h.rowOf('全都要')['手機'], phone(2));
  assert.ok(h.ui.alerts[1].message.includes('已清除 2 筆'), h.ui.alerts[1].message);

  h.clearOldContacts();
  assert.ok(h.ui.alerts[3].message.includes('已清除 0 筆'), '已刪除的不重複計算');
});

test('清除所有聯絡資料：包含目前場次，空白欄位維持空白', () => {
  const h = withOldEvent();
  h.clearAllContacts();
  const frog = h.rowOf('螢火蟲');
  assert.strictEqual(frog['LINE ID'], '（已刪除）');
  assert.strictEqual(frog['手機'], '');
  assert.strictEqual(frog['IG 帳號'], '');
  const all = h.rowOf('全都要');
  assert.strictEqual(all['手機'], '（已刪除）');
  assert.strictEqual(all['LINE ID'], '（已刪除）');
  assert.strictEqual(all['IG 帳號'], '（已刪除）');
  assert.strictEqual(h.rowOf('舊場次')['手機'], '（已刪除）');
  assert.ok(h.ui.alerts[1].message.includes('已清除 4 筆'), h.ui.alerts[1].message);

  // 清除後名單照常顯示，也能繼續報名
  const st = h.get();
  assert.strictEqual(st.confirmed.length, 2);
  assert.strictEqual(h.post({ nickname: '新來的', line: 'brand_new' }).ok, true);
});

test('確認視窗按「否」時什麼都不改', () => {
  const h = withOldEvent();
  h.ui.answer = 'NO';
  h.clearAllContacts();
  h.clearOldContacts();
  assert.strictEqual(h.rowOf('舊場次')['手機'], '0911111111');
  assert.strictEqual(h.rowOf('螢火蟲')['LINE ID'], 'frog.king_1');
  assert.strictEqual(h.ui.alerts.length, 2, '只有兩次確認視窗，沒有「完成」');
});
