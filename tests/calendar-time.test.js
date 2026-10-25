// 網頁的加入行事曆時間規則（calendar-time.js）。
// tools/sync_event.py 產生 event.ics 時用同一份案例檢查（tests/test_sync_event.py），
// 兩邊一致，網頁比對 event.ics 時才不會誤把「Apple／其他」按鈕藏起來。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CASES = require('./default-end-cases.json');

function loadCalendarTime() {
  const file = path.join(__dirname, '..', 'calendar-time.js');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx.window.NightWalkTime;
}

const hm = t => String(t.h).padStart(2, '0') + ':' + String(t.mi).padStart(2, '0');

test('沒填結束時間：開始後 2 小時，最晚到當天 23:59', () => {
  const { defaultEnd } = loadCalendarTime();
  for (const [start, end] of CASES) {
    const [h, mi] = start.split(':').map(Number);
    assert.strictEqual(hm(defaultEnd({ h, mi })), end, '開始 ' + start);
  }
});
