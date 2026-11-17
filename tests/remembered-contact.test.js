// 「在這支手機記住我的資料」（remembered-contact.js）：只存在報名者的瀏覽器，下次報名自動帶入。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 18);

function load() {
  const file = path.join(ROOT, 'remembered-contact.js');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx.window.NightWalkRemember;
}

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: k => { data.delete(k); },
  };
}

/** 無痕模式等：每個操作都丟錯。 */
const brokenStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
};

const ME = { nickname: '小明', phone: '0912345678', line: 'ming', ig: '' };
const FRIEND = { nickname: '阿華', phone: '0922333444', line: '', ig: 'hua' };

test('記住後讀得回暱稱和三種聯絡方式，不記「給主辦的話」', () => {
  const r = load();
  const s = fakeStorage();
  r.save(s, Object.assign({ message: '第一次參加' }, ME), NOW);
  const got = r.read(s, NOW);
  assert.deepStrictEqual(
    { nickname: got.nickname, phone: got.phone, line: got.line, ig: got.ig },
    ME
  );
  assert.ok(!s.getItem(r.KEY).includes('第一次參加'));
});

test('跟「已報名」狀態用不同的鍵，場次代碼不會撞名', () => {
  const r = load();
  assert.ok(!r.KEY.startsWith('night-walk:'));
});

test('最後一次用到之後一年內還在；超過一年就清除', () => {
  const r = load();
  const s = fakeStorage();
  r.save(s, ME, NOW);
  assert.ok(r.read(s, NOW + 364 * DAY));
  assert.strictEqual(r.read(s, NOW + 366 * DAY), null);
  assert.strictEqual(s.getItem(r.KEY), null, '過期的資料要從手機上刪掉');
});

test('清除後讀不到', () => {
  const r = load();
  const s = fakeStorage();
  r.save(s, ME, NOW);
  r.clear(s);
  assert.strictEqual(r.read(s, NOW), null);
});

test('沒有資料、資料壞掉、缺暱稱或缺時間：都當成沒有記住', () => {
  const r = load();
  assert.strictEqual(r.read(fakeStorage(), NOW), null);
  for (const bad of ['{', 'null', '"x"', '{"phone":"0912345678","usedAt":1}', '{"nickname":"小明"}']) {
    assert.strictEqual(r.read(fakeStorage({ [r.KEY]: bad }), NOW), null, bad);
  }
});

test('瀏覽器不讓存取時不會出錯，當成沒有記住', () => {
  const r = load();
  for (const s of [brokenStorage, null]) {
    assert.strictEqual(r.read(s, NOW), null);
    assert.doesNotThrow(() => r.save(s, ME, NOW));
    assert.doesNotThrow(() => r.clear(s));
    assert.strictEqual(r.afterSignup(s, ME, NOW), 'save');
  }
});

test('報名成功後：還沒記住時問要不要記住，但先不存', () => {
  const r = load();
  const s = fakeStorage();
  assert.strictEqual(r.afterSignup(s, ME, NOW), 'save');
  assert.strictEqual(r.read(s, NOW), null, '報名者按「記住」之前不能存');
});

test('報名成功後：跟記住的一樣就不問，並延長一年', () => {
  const r = load();
  const s = fakeStorage();
  r.save(s, ME, NOW);
  const later = NOW + 300 * DAY;
  assert.strictEqual(r.afterSignup(s, ME, later), null);
  assert.ok(r.read(s, later + 300 * DAY), '從這次報名重新算一年');
});

test('報名成功後：幫朋友報名（資料不同）時問要不要換掉，不先動到記住的資料', () => {
  const r = load();
  const s = fakeStorage();
  r.save(s, ME, NOW);
  assert.strictEqual(r.afterSignup(s, FRIEND, NOW + DAY), 'replace');
  const got = r.read(s, NOW + DAY);
  assert.strictEqual(got.nickname, ME.nickname);
  assert.strictEqual(got.usedAt, NOW, '朋友的報名不延長自己資料的期限');
});

test('只改了一種聯絡方式也算不同', () => {
  const r = load();
  assert.strictEqual(r.prompt(ME, Object.assign({}, ME, { ig: 'ming.ig' })), 'replace');
  assert.strictEqual(r.prompt(ME, Object.assign({}, ME)), null);
});

test('網頁有載入這支程式，個資說明有寫記住的資料只存在這支手機', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('remembered-contact.js') >= 0);
  assert.ok(scripts.indexOf('remembered-contact.js') < scripts.indexOf('app.js'), '要在 app.js 之前載入');
  const privacy = /<p class="privacy">([^<]+)<\/p>/.exec(html)[1];
  assert.match(privacy, /只存在這支手機的瀏覽器，主辦看不到，可隨時清除/);
});
