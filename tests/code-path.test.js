// CODE_GS_PATH：讓測試載入 Code.gs 的複本，做突變檢查時不用動 repo 裡的檔案。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshEvent } = require('./fake-apps-script');

test('設定 CODE_GS_PATH 時載入指定的 Code.gs 複本', t => {
  const original = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-walk-'));
  const copy = path.join(dir, 'Code.gs');
  fs.writeFileSync(copy, original.replace(/const NOTIFY_EMAIL = '[^']*';/, "const NOTIFY_EMAIL = 'copy@example.test';"));
  process.env.CODE_GS_PATH = copy;
  t.after(() => {
    delete process.env.CODE_GS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const h = freshEvent();
  h.post({ nickname: '複本', phone: '0912345678' });
  assert.strictEqual(h.mail.sent[0].to, 'copy@example.test');

  delete process.env.CODE_GS_PATH;
  const real = freshEvent();
  real.post({ nickname: '正本', phone: '0912345678' });
  assert.notStrictEqual(real.mail.sent[0].to, 'copy@example.test');
});
