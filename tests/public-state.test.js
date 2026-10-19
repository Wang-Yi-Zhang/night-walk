// 讀取（GET）：公開狀態的內容、不外洩聯絡資料、快取。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshEvent, eq, DEFAULT_NOW } = require('./fake-apps-script');

test('預設設定的公開狀態', () => {
  const h = freshEvent();
  const st = h.get();
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.event.id, '2026-10-23');
  assert.strictEqual(st.event.name, '麟光夜行・富陽生態公園');
  assert.strictEqual(st.event.date, '2026-10-23');
  assert.strictEqual(st.event.start, '19:00');
  assert.strictEqual(st.event.end, '21:00');
  assert.strictEqual(st.event.status, '正常舉行');
  assert.strictEqual(st.event.deadline, '2026-10-23 12:00');
  assert.ok(st.event.mapUrl.startsWith('https://'));
  eq(st.event.bring, ['手電筒', '長袖長褲', '鞋子（建議雨鞋）', '愉快的心情']);
  assert.strictEqual(st.capacity, 10);
  assert.strictEqual(st.waitlistCapacity, 5);
  eq(st.confirmed, []);
  eq(st.waitlist, []);
  eq(st.registration, { open: true, mode: '正取', reason: null });
  assert.strictEqual(st.generatedAt, new Date(DEFAULT_NOW).toISOString());
});

test('攜帶提醒也接受頓號分隔；地圖連結只接受 https', () => {
  const h = freshEvent();
  h.setSetting('攜帶提醒', '手電筒、水\n 雨衣 ');
  h.setSetting('地圖連結', 'javascript:alert(1)');
  const st = h.get();
  eq(st.event.bring, ['手電筒', '水', '雨衣']);
  assert.strictEqual(st.event.mapUrl, '');
});

test('上限無法解析時退回預設值 10 和 5', () => {
  const h = freshEvent();
  h.setSetting('正取上限', '十個');
  h.setSetting('候補上限', '-3');
  const st = h.get();
  assert.strictEqual(st.capacity, 10);
  assert.strictEqual(st.waitlistCapacity, 5);
});

test('公開狀態永遠不含任何聯絡方式，也不含給主辦的話', () => {
  const h = freshEvent();
  h.post({ nickname: '手機族', phone: '0911222333', message: '我會帶朋友' });
  h.post({ nickname: '賴族', line: 'secret_line' });
  h.post({ nickname: '圖族', ig: 'secret.ig' });
  h.post({ nickname: '全都要', phone: '0944555666', line: 'all_in', ig: 'all.in' });
  const pub = JSON.stringify(h.get());
  ['0911222333', 'secret_line', 'secret.ig', '0944555666', 'all_in', 'all.in', '我會帶朋友'].forEach(v => {
    assert.ok(!pub.includes(v), '外洩：' + v);
  });
  eq(h.get().confirmed, ['手機族', '賴族', '圖族', '全都要']);
});

test('只計入目前場次、身分為正取或候補、而且有暱稱的列', () => {
  const h = freshEvent();
  h.post({ nickname: '甲', phone: '0900000001' });
  h.post({ nickname: '乙', phone: '0900000002' });
  h.post({ nickname: '丙', phone: '0900000003' });
  h.editSignup('乙', '身分', '取消');
  h.editSignup('丙', '場次代碼', "'2026-09-01");
  h.sheet('報名').appendRow(['', "'2026-10-23", '', '', '', '', '正取', '']); // 沒有暱稱的空白列
  const st = h.get();
  eq(st.confirmed, ['甲']);
  eq(st.waitlist, []);
});

test('結果快取 30 秒：刪除整列不會立刻反映，30 秒後才更新', () => {
  const h = freshEvent();
  h.post({ nickname: '甲', phone: '0900000001' });
  h.post({ nickname: '乙', phone: '0900000002' });
  eq(h.get().confirmed, ['甲', '乙']);

  h.deleteSignupRow('乙');
  eq(h.get().confirmed, ['甲', '乙'], '快取還在');
  h.advance(29 * 1000);
  eq(h.get().confirmed, ['甲', '乙'], '還沒滿 30 秒');
  h.advance(1000);
  eq(h.get().confirmed, ['甲'], '30 秒後重新讀取');
});

test('新增報名和編輯儲存格都會清除快取', () => {
  const h = freshEvent();
  h.post({ nickname: '甲', phone: '0900000001' });
  eq(h.get().confirmed, ['甲']);
  h.post({ nickname: '乙', phone: '0900000002' });
  eq(h.get().confirmed, ['甲', '乙'], '新增報名後立刻反映');
  h.editSignup('乙', '身分', '取消');
  eq(h.get().confirmed, ['甲'], '編輯後立刻反映');
});
