// 本機假後端（mock-api.js）與真正後端（Code.gs）的規則一致性。
// 同一個情境分別交給兩邊，比較公開狀態的欄位、能否報名、報名結果與錯誤碼。
// 錯誤訊息文字不比較：假後端只求預覽時看得出是哪一種錯誤。
'use strict';

const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { freshEvent, eq, phone } = require('./fake-apps-script');

const MOCK_PATH = path.join(__dirname, '..', 'mock-api.js');

/** 在 vm 裡載入 mock-api.js；延遲改成立即執行，結果轉成這個 realm 的物件。 */
function loadMock(scenario) {
  const ctx = { window: {}, setTimeout: fn => fn() };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(MOCK_PATH, 'utf8'), ctx, { filename: MOCK_PATH });
  const api = ctx.window.NightWalkMock(scenario);
  const plain = x => JSON.parse(JSON.stringify(x));
  return {
    get: async () => plain(await api.get()),
    post: async body => plain(await api.post(body)),
  };
}

/**
 * 真正後端，人數跟假後端的某個情境相同；活動狀態與截止依情境的設定，
 * 不看假後端算出的能否報名，否則假後端算錯時兩邊會一起錯。
 */
function backendLike(scenario, mockState) {
  const h = freshEvent();
  const eventId = h.get().event.id;
  let n = 0;
  const add = (nickname, status) => {
    n++;
    h.sheet('報名').appendRow([new Date(), "'" + eventId, "'" + nickname, "'" + phone(9000 + n), '', '', status, '']);
  };
  mockState.confirmed.forEach(nick => add(nick, '正取'));
  mockState.waitlist.forEach(nick => add(nick, '候補'));
  if (mockState.event.status !== '正常舉行') h.setSetting('活動狀態', mockState.event.status);
  if (scenario === 'deadline') h.setSetting('報名截止', '2020-01-01 00:00');
  h.advance(31 * 1000); // 直接加列不會清除快取，等快取過期
  return h;
}

/** 網頁送出的報名資料：沒填的欄位是空字串。 */
const body = fields => Object.assign({ phone: '', line: '', ig: '', message: '', website: '' }, fields);

/** 報名結果去掉錯誤訊息文字。 */
const withoutMessage = r => {
  const { message, ...rest } = r;
  return rest;
};

const keys = obj => Object.keys(obj).sort();

test('公開狀態的欄位跟真正後端相同', async () => {
  const mock = await loadMock('empty').get();
  const real = freshEvent().get();
  eq(keys(mock), keys(real));
  eq(keys(mock.event), keys(real.event));
  eq(keys(mock.registration), keys(real.registration));
});

test('每個預覽情境的能否報名、人數，跟同樣人數的真正後端相同', async () => {
  // '' 是網址只寫 ?mock 時的預設情境
  for (const scenario of ['', 'empty', 'wait', 'hold', 'full', 'rain', 'deadline', 'notice']) {
    const mock = await loadMock(scenario).get();
    const real = backendLike(scenario, mock).get();
    eq(mock.registration, real.registration, '情境 ' + scenario);
    eq([mock.confirmed.length, mock.waitlist.length], [real.confirmed.length, real.waitlist.length], '情境 ' + scenario);
  }
});

test('從空的開始報名：正取 10 人、候補 5 人、之後額滿，結果逐筆相同', async () => {
  const mock = loadMock('empty');
  const real = freshEvent();
  for (let i = 1; i <= 16; i++) {
    const b = body({ nickname: '人' + i, phone: phone(i) });
    eq(withoutMessage(await mock.post(b)), withoutMessage(real.post(b)), '第 ' + i + ' 筆');
  }
});

test('A-2：有人在候補時，正取有空位也進候補', async () => {
  const mock = loadMock('hold');
  const real = backendLike('hold', await mock.get());
  const b = body({ nickname: '新人', phone: phone(5000) });
  eq(withoutMessage(await mock.post(b)), withoutMessage(real.post(b)));
});

test('格式錯誤的錯誤碼相同（輸入都已經過網頁整理）', async () => {
  const cases = [
    { nickname: '', phone: phone(1) },
    { nickname: '一二三四五六七八九十一二三', phone: phone(1) },
    { nickname: '沒聯絡' },
    { nickname: 'a', phone: '0812345678' },
    { nickname: 'a', line: 'abc' },
    { nickname: 'a', line: 'a'.repeat(21) },
    { nickname: 'a', ig: 'dash-no' },
    { nickname: 'a', phone: phone(1), line: '王小明' },
    { nickname: '機器人', phone: phone(1), website: 'http://spam' },
  ];
  for (const c of cases) {
    const b = body(c);
    eq((await loadMock('empty').post(b)).error, freshEvent().post(b).error, JSON.stringify(c));
  }
});

test('重複報名：三種聯絡方式各自判斷，field 相同', async () => {
  const mock = loadMock('empty');
  const real = freshEvent();
  const first = body({ nickname: '先來', phone: phone(1), line: 'first_line', ig: 'first.ig' });
  eq(withoutMessage(await mock.post(first)), withoutMessage(real.post(first)));
  for (const dup of [{ phone: phone(1) }, { line: 'first_line' }, { ig: 'first.ig' }, { phone: phone(2), ig: 'first.ig' }]) {
    const b = body(Object.assign({ nickname: '後到' }, dup));
    eq(withoutMessage(await mock.post(b)), withoutMessage(real.post(b)), JSON.stringify(dup));
  }
});
