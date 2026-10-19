// 能否報名：活動狀態、報名開關、截止時間（台灣時區），以及寫入鎖與頻率限制。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshEvent, eq, phone } = require('./fake-apps-script');

const closed = reason => ({ open: false, mode: null, reason });

test('活動狀態不是「正常舉行」時停止報名，並帶出補充說明', () => {
  const h = freshEvent();
  h.setSetting('活動狀態', '因雨取消');
  h.setSetting('狀態補充說明', '延期至 10/30（五）');
  const st = h.get();
  eq(st.registration, closed('status'));
  assert.strictEqual(st.event.status, '因雨取消');
  assert.strictEqual(st.event.statusNote, '延期至 10/30（五）');
  const r = h.post({ nickname: '雨人', phone: phone(1) });
  assert.strictEqual(r.error, 'status');
  assert.ok(r.message.length > 0);
  assert.strictEqual(h.rows().length, 0);

  h.setSetting('活動狀態', '延期');
  assert.strictEqual(h.post({ nickname: '雨人', phone: phone(1) }).error, 'status');
});

test('「正常舉行」加上補充說明：報名照常開放', () => {
  const h = freshEvent();
  h.setSetting('狀態補充說明', '集合地點改到 2 號出口');
  const st = h.get();
  assert.strictEqual(st.event.statusNote, '集合地點改到 2 號出口');
  assert.strictEqual(st.registration.open, true);
});

test('活動狀態留空視為正常舉行', () => {
  const h = freshEvent();
  h.setSetting('活動狀態', '');
  const st = h.get();
  assert.strictEqual(st.event.status, '正常舉行');
  assert.strictEqual(st.registration.open, true);
});

test('報名開關「關」時停止報名，改回「開」就恢復', () => {
  const h = freshEvent();
  h.setSetting('報名開關', '關');
  eq(h.get().registration, closed('closed'));
  assert.strictEqual(h.post({ nickname: '甲', phone: phone(1) }).error, 'closed');
  h.setSetting('報名開關', '開');
  assert.strictEqual(h.post({ nickname: '甲', phone: phone(1) }).ok, true);
});

test('判斷順序：活動狀態 → 報名開關 → 截止時間 → 額滿', () => {
  const h = freshEvent();
  h.setSetting('正取上限', '0');
  h.setSetting('候補上限', '0');
  assert.strictEqual(h.get().registration.reason, 'full');
  h.setSetting('報名截止', '2020-01-01 00:00');
  assert.strictEqual(h.get().registration.reason, 'deadline');
  h.setSetting('報名開關', '關');
  assert.strictEqual(h.get().registration.reason, 'closed');
  h.setSetting('活動狀態', '因雨取消');
  assert.strictEqual(h.get().registration.reason, 'status');
});

test('截止時間以台灣時間計算：12:00 前一刻可以報名，12:00 整截止', () => {
  // 2026-10-23 12:00 台灣時間 = 2026-10-23 04:00 UTC
  const h = freshEvent({ now: Date.UTC(2026, 9, 23, 3, 59, 59, 999), tickMs: 0 });
  h.setSetting('報名截止', '2026-10-23 12:00');
  assert.strictEqual(h.get().registration.open, true);
  const r = h.post({ nickname: '壓線', phone: phone(1) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));

  h.clock.now = Date.UTC(2026, 9, 23, 4, 0, 0);
  h.setSetting('報名截止', '2026-10-23 12:00'); // 編輯儲存格，清除快取
  eq(h.get().registration, closed('deadline'));
  const late = h.post({ nickname: '遲到', phone: phone(2) });
  assert.strictEqual(late.error, 'deadline');
  assert.strictEqual(h.rowOf('遲到'), undefined);
});

test('截止時間：台灣時間的「早上」在 UTC 是前一天', () => {
  // 2026-10-23 07:30 台灣時間 = 2026-10-22 23:30 UTC
  const h = freshEvent({ now: Date.UTC(2026, 9, 22, 23, 29), tickMs: 0 });
  h.setSetting('報名截止', '2026-10-23 07:30');
  assert.strictEqual(h.get().registration.open, true, 'UTC 還在 10/22，但台灣時間 07:29 還沒截止');
  h.clock.now = Date.UTC(2026, 9, 22, 23, 30);
  h.setSetting('報名截止', '2026-10-23 07:30');
  assert.strictEqual(h.get().registration.reason, 'deadline', '台灣時間 07:30 截止');
});

test('截止時間也接受斜線與一位數的月、日、時', () => {
  const h = freshEvent({ now: Date.UTC(2026, 9, 23, 1, 4), tickMs: 0 }); // 台灣 09:04
  h.setSetting('報名截止', '2026/10/23 9:05');
  assert.strictEqual(h.get().registration.open, true);
  h.clock.now = Date.UTC(2026, 9, 23, 1, 5); // 台灣 09:05
  h.setSetting('報名截止', '2026/10/23 9:05');
  assert.strictEqual(h.get().registration.reason, 'deadline');
});

test('截止時間留空或格式無法解析時，視為不截止（已知風險）', () => {
  const h = freshEvent({ now: Date.UTC(2030, 0, 1) });
  h.setSetting('報名截止', '');
  assert.strictEqual(h.get().registration.open, true);
  h.setSetting('報名截止', '明天');
  assert.strictEqual(h.get().registration.open, true);
  h.setSetting('報名截止', '2026-10-23');
  assert.strictEqual(h.get().registration.open, true, '少了時間也會變成不截止');
  assert.strictEqual(h.get().event.deadline, '2026-10-23', '原始文字照樣公開');
});

test('拿不到寫入鎖時回傳 busy，不寫入', () => {
  const h = freshEvent();
  h.lock.available = false;
  const r = h.post({ nickname: '擠不進', phone: phone(1) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'busy');
  assert.strictEqual(h.rows().length, 0);
  h.lock.available = true;
  assert.strictEqual(h.post({ nickname: '擠不進', phone: phone(1) }).ok, true);
});

test('格式錯誤在拿鎖之前就擋下，不受鎖影響', () => {
  const h = freshEvent();
  h.lock.available = false;
  assert.strictEqual(h.post({ nickname: '', phone: phone(1) }).error, 'nickname');
});

test('全站每分鐘最多 20 筆報名請求，超過回傳 busy；下一分鐘恢復', () => {
  const h = freshEvent({ now: Date.UTC(2026, 9, 20, 0, 0, 0), tickMs: 1000 });
  h.setSetting('正取上限', '30');
  for (let i = 1; i <= 20; i++) {
    const r = h.post({ nickname: '人' + i, phone: phone(i) });
    assert.strictEqual(r.ok, true, '第 ' + i + ' 筆：' + JSON.stringify(r));
  }
  const r = h.post({ nickname: '第21', phone: phone(21) });
  assert.strictEqual(r.error, 'busy');
  assert.strictEqual(h.rowOf('第21'), undefined);
  assert.strictEqual(h.lock.held, false, '被限制時也要釋放鎖');

  h.clock.now = Date.UTC(2026, 9, 20, 0, 1, 0);
  assert.strictEqual(h.post({ nickname: '第21', phone: phone(21) }).ok, true);
});

test('每次報名結束都會釋放鎖（成功、重複、額滿）', () => {
  const h = freshEvent();
  h.setSetting('正取上限', '1');
  h.setSetting('候補上限', '0');
  h.post({ nickname: '甲', phone: phone(1) });
  assert.strictEqual(h.lock.held, false);
  assert.strictEqual(h.post({ nickname: '乙', phone: phone(1) }).error, 'duplicate');
  assert.strictEqual(h.lock.held, false);
  assert.strictEqual(h.post({ nickname: '丙', phone: phone(3) }).error, 'full');
  assert.strictEqual(h.lock.held, false);
});
