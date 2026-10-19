// 報名（POST）的輸入：格式錯誤、聯絡方式的整理與格式規則、存成純文字。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshEvent } = require('./fake-apps-script');

const errorOf = (h, body) => h.post(body).error;

test('資料格式錯誤：不是 JSON、空的、過大、沒有 postData', () => {
  const h = freshEvent();
  assert.strictEqual(h.postRaw('not json').error, 'invalid');
  assert.strictEqual(h.postRaw('').error, 'invalid');
  assert.strictEqual(h.postRaw(undefined).error, 'invalid');
  assert.strictEqual(h.postRaw(JSON.stringify({ nickname: 'a', phone: '0912345678', message: 'x'.repeat(2000) })).error, 'invalid');
  assert.strictEqual(h.postRaw('null').error, 'nickname', 'null 當成空物件處理');
  const r = h.postRaw('not json');
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.length > 0, '附上可顯示的中文訊息');
});

test('honeypot 欄位有填就擋下，空字串照常報名', () => {
  const h = freshEvent();
  assert.strictEqual(errorOf(h, { nickname: '機器人', phone: '0912345678', website: 'http://spam' }), 'invalid');
  assert.strictEqual(h.rows().length, 0);
  assert.strictEqual(h.post({ nickname: '真人', phone: '0912345678', website: '' }).ok, true);
});

test('暱稱 1–12 字（以字元計，emoji 算一個字），前後空白和隱形字元會去掉', () => {
  const h = freshEvent();
  assert.strictEqual(errorOf(h, { nickname: '', phone: '0900000001' }), 'nickname');
  assert.strictEqual(errorOf(h, { nickname: '   ', phone: '0900000001' }), 'nickname');
  assert.strictEqual(errorOf(h, { nickname: '​‮', phone: '0900000001' }), 'nickname');
  assert.strictEqual(errorOf(h, { nickname: '一二三四五六七八九十一二三', phone: '0900000001' }), 'nickname');

  let r = h.post({ nickname: '一二三四五六七八九十一二', phone: '0900000001' });
  assert.strictEqual(r.ok, true, '12 字可以');
  r = h.post({ nickname: '🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸', phone: '0900000002' });
  assert.strictEqual(r.ok, true, '12 個 emoji 可以');
  r = h.post({ nickname: '  小​  明  ', phone: '0900000003' });
  assert.strictEqual(r.nickname, '小 明');
  assert.ok(h.rowOf('小 明'));
});

test('三種聯絡方式至少填一項', () => {
  const h = freshEvent();
  assert.strictEqual(errorOf(h, { nickname: 'a' }), 'contact');
  assert.strictEqual(errorOf(h, { nickname: 'a', phone: '  ', line: '', ig: '@' }), 'contact');
  assert.strictEqual(errorOf(h, { nickname: 'a', line: '@' }), 'contact');
});

test('各欄位格式錯誤時回傳對應的錯誤碼', () => {
  const h = freshEvent();
  assert.strictEqual(errorOf(h, { nickname: 'a', phone: '0812345678' }), 'phone');
  assert.strictEqual(errorOf(h, { nickname: 'a', phone: '091234567' }), 'phone');
  assert.strictEqual(errorOf(h, { nickname: 'a', phone: '09123456789' }), 'phone');
  assert.strictEqual(errorOf(h, { nickname: 'a', line: '王小明🐸' }), 'line', '顯示名稱不是 LINE ID');
  assert.strictEqual(errorOf(h, { nickname: 'a', line: 'abc' }), 'line', '少於 4 字');
  assert.strictEqual(errorOf(h, { nickname: 'a', line: 'a'.repeat(21) }), 'line', '多於 20 字');
  assert.strictEqual(errorOf(h, { nickname: 'a', ig: 'has space' }), 'ig');
  assert.strictEqual(errorOf(h, { nickname: 'a', ig: 'dash-no' }), 'ig');
  assert.strictEqual(errorOf(h, { nickname: 'a', ig: '小明' }), 'ig');
  assert.strictEqual(errorOf(h, { nickname: 'a', ig: 'a'.repeat(31) }), 'ig');
  assert.strictEqual(errorOf(h, { nickname: 'a', phone: '0912345678', message: '字'.repeat(201) }), 'message');
  assert.strictEqual(h.rows().length, 0);
});

test('選填的欄位填錯，即使其他欄位正確也會擋下', () => {
  const h = freshEvent();
  assert.strictEqual(errorOf(h, { nickname: 'a', phone: '0933333333', line: '小明' }), 'line');
  assert.strictEqual(errorOf(h, { nickname: 'a', line: 'good_id', ig: 'bad ig' }), 'ig');
  assert.strictEqual(errorOf(h, { nickname: 'a', ig: 'good.ig', phone: '12345' }), 'phone');
  assert.strictEqual(h.rows().length, 0);
});

test('格式的邊界值：LINE ID 4 與 20 字、IG 1 與 30 字、給主辦的話 200 字', () => {
  const h = freshEvent();
  assert.strictEqual(h.post({ nickname: 'a', line: 'abcd' }).ok, true);
  assert.strictEqual(h.post({ nickname: 'b', line: 'a'.repeat(20) }).ok, true);
  assert.strictEqual(h.post({ nickname: 'c', ig: 'x' }).ok, true);
  assert.strictEqual(h.post({ nickname: 'd', ig: 'y'.repeat(30) }).ok, true);
  assert.strictEqual(h.post({ nickname: 'e', line: 'a.b_c-d' }).ok, true, 'LINE ID 可以有 . _ -');
  assert.strictEqual(h.post({ nickname: 'f', phone: '0900000001', message: '字'.repeat(200) }).ok, true);
});

test('整理規則：只填 LINE ID（大寫、@ 開頭）存成小寫、沒有 @', () => {
  const h = freshEvent();
  const r = h.post({ nickname: '螢火蟲', line: '@Frog.King_1' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const row = h.rowOf('螢火蟲');
  assert.strictEqual(row['LINE ID'], 'frog.king_1');
  assert.strictEqual(row['手機'], '');
  assert.strictEqual(row['IG 帳號'], '');
});

test('整理規則：LINE 加好友網址與 IG 個人頁網址取出 ID', () => {
  const h = freshEvent();
  assert.strictEqual(h.post({ nickname: '樹蛙', line: 'https://line.me/ti/p/~Tree_Frog' }).ok, true);
  assert.strictEqual(h.rowOf('樹蛙')['LINE ID'], 'tree_frog');
  assert.strictEqual(h.post({ nickname: '貓頭鷹', ig: 'https://www.instagram.com/Night.Owl_tw/?hl=zh-tw' }).ok, true);
  assert.strictEqual(h.rowOf('貓頭鷹')['IG 帳號'], 'night.owl_tw');
  assert.strictEqual(h.post({ nickname: '蝸牛', ig: ' @Snail.TW ' }).ok, true);
  assert.strictEqual(h.rowOf('蝸牛')['IG 帳號'], 'snail.tw');
});

test('整理規則：手機去掉空白、連字號、括號，+886 轉成 09', () => {
  const h = freshEvent();
  assert.strictEqual(h.post({ nickname: '甲', phone: '+886 912-345-678' }).ok, true);
  assert.strictEqual(h.rowOf('甲')['手機'], '0912345678');
  assert.strictEqual(h.post({ nickname: '乙', phone: '(0922) 333.444' }).ok, true);
  assert.strictEqual(h.rowOf('乙')['手機'], '0922333444');
  assert.strictEqual(h.post({ nickname: '丙', phone: '886933444555' }).ok, true);
  assert.strictEqual(h.rowOf('丙')['手機'], '0933444555');
});

test('多填：手機加 IG 都存下來', () => {
  const h = freshEvent();
  const r = h.post({ nickname: '多填', phone: '+886955555555', ig: 'multi.fill' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const row = h.rowOf('多填');
  assert.strictEqual(row['手機'], '0955555555');
  assert.strictEqual(row['IG 帳號'], 'multi.fill');
  assert.strictEqual(row['LINE ID'], '');
});

test('舊網頁只送暱稱、手機和給主辦的話，仍可報名', () => {
  const h = freshEvent();
  const r = h.post({ nickname: '舊網頁', phone: '0966666666', message: 'hi' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(h.rowOf('舊網頁')['給主辦的話'], 'hi');
});

test('使用者輸入一律以 \' 前綴存成純文字：防公式注入、保住手機開頭的 0', () => {
  const h = freshEvent();
  const r = h.post({ nickname: '=IMPORT(1)', phone: '0912345678', line: 'formula_ok', message: '+SUM(1)' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const raw = h.rawOf('=IMPORT(1)');
  assert.strictEqual(raw['暱稱'], "'=IMPORT(1)");
  assert.strictEqual(raw['手機'], "'0912345678");
  assert.strictEqual(raw['LINE ID'], "'formula_ok");
  assert.strictEqual(raw['給主辦的話'], "'+SUM(1)");
  assert.strictEqual(raw['場次代碼'], "'2026-10-23");
  assert.strictEqual(raw['IG 帳號'], '', '空的欄位維持空白，不加前綴');
  assert.strictEqual(raw['身分'], '正取');
});

test('給主辦的話保留換行，去掉控制字元', () => {
  const h = freshEvent();
  h.post({ nickname: '話多', phone: '0912345678', message: '  第一行\r\n第二行\u0007​  ' });
  assert.strictEqual(h.rowOf('話多')['給主辦的話'], '第一行\n第二行');
});
