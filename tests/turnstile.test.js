// 防機器人驗證（Cloudflare Turnstile）：指令碼屬性有密鑰才啟用，
// 驗證在上鎖之前，沒通過或連不上 Cloudflare 都不寫入。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshEvent, phone } = require('./fake-apps-script');

const SECRET = 'test-secret';
const withSecret = () => freshEvent({ scriptProperties: { TURNSTILE_SECRET: SECRET } });
const signup = (i, token) => ({ nickname: '人' + i, phone: phone(i), turnstileToken: token });

test('沒設定密鑰時不驗證：不連 Cloudflare，沒帶 token 也照常報名', () => {
  const h = freshEvent();
  assert.strictEqual(h.post({ nickname: '甲', phone: phone(1) }).ok, true);
  assert.strictEqual(h.post(signup(2, 'anything')).ok, true);
  assert.strictEqual(h.fetches.calls.length, 0);
});

test('設定密鑰後：token 通過才寫入，送給 Cloudflare 的是密鑰和 token', () => {
  const h = withSecret();
  const r = h.post(signup(1, 'pass'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.rows().length, 1);
  assert.strictEqual(h.fetches.calls.length, 1);
  const call = h.fetches.calls[0];
  assert.strictEqual(call.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.strictEqual(call.params.method, 'post');
  assert.strictEqual(call.params.payload.secret, SECRET);
  assert.strictEqual(call.params.payload.response, 'pass');
});

test('設定密鑰後：沒帶、帶錯、太長或不是字串的 token 都擋下，不寫入', () => {
  const h = withSecret();
  for (const token of [undefined, '', 'wrong', 'p'.repeat(2049), ['pass'], 123]) {
    const r = h.post(signup(1, token));
    assert.strictEqual(r.error, 'captcha', JSON.stringify(token));
    assert.ok(r.message.length > 0);
  }
  assert.strictEqual(h.rows().length, 0);
  assert.strictEqual(h.mail.sent.length, 0);
  assert.strictEqual(h.fetches.calls.length, 1, '只有「帶錯」需要問 Cloudflare');
});

test('連不上 Cloudflare、非 200、回應不是 JSON：一律擋下（不放行），並留下紀錄', () => {
  const responders = [
    () => { throw new Error('DNS error'); },
    () => ({ code: 500, body: 'oops' }),
    () => ({ code: 200, body: '<html>' }),
  ];
  for (const respond of responders) {
    const h = withSecret();
    h.fetches.respond = respond;
    const r = h.post(signup(1, 'pass'));
    assert.strictEqual(r.error, 'captcha');
    assert.strictEqual(h.rows().length, 0);
    assert.ok(h.logs.some(l => l[0] === 'error'));
  }
});

test('欄位格式錯誤時先回欄位錯誤，不用掉 token', () => {
  const h = withSecret();
  assert.strictEqual(h.post({ nickname: '', phone: phone(1), turnstileToken: 'pass' }).error, 'nickname');
  assert.strictEqual(h.fetches.calls.length, 0);
});

test('驗證在上鎖之前：沒通過的請求不占鎖，也不計入每分鐘的報名次數', () => {
  const h = withSecret();
  h.lock.available = false;
  assert.strictEqual(h.post(signup(1, 'wrong')).error, 'captcha', '拿不到鎖時，沒通過驗證的仍回 captcha');
  h.lock.available = true;

  const fast = freshEvent({ scriptProperties: { TURNSTILE_SECRET: SECRET }, tickMs: 0 });
  for (let i = 0; i < 30; i++) assert.strictEqual(fast.post(signup(i, 'wrong')).error, 'captcha');
  assert.strictEqual(fast.post(signup(99, 'pass')).ok, true, '灌了 30 次沒通過的請求，真人仍能報名');
});

test('最長的 token 加上最長的留言和所有欄位，不會被當成資料過大', () => {
  const h = withSecret();
  h.fetches.respond = () => ({ code: 200, body: { success: true } });
  const r = h.post({
    nickname: '一二三四五六七八九十一二',
    phone: phone(1),
    line: 'l'.repeat(20),
    ig: 'i'.repeat(30),
    message: '字'.repeat(200),
    website: '',
    turnstileToken: 't'.repeat(2048),
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
