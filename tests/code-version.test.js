// 部署版本：Code.gs 的 CODE_VERSION 是本檔其餘內容的雜湊值，放在公開資料的 version。
// tools/sync_event.py --check 用同樣的算法比對正式後端，抓出「改了 Code.gs 卻忘了重新部署」。
// 一律讀 repo 裡的 Code.gs（不看 CODE_GS_PATH），突變檢查時這裡才不會每次都先失敗。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { freshEvent } = require('./fake-apps-script');

const CODE_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const CONSTANT = /const CODE_VERSION = '([^']*)';/;

/** 跟 tools/sync_event.py 的 code_version() 相同：換行統一成 LF，CODE_VERSION 的值清空後取 SHA-256 前 12 碼。 */
function codeVersion(text) {
  const blank = text.replace(/\r\n/g, '\n').replace(CONSTANT, "const CODE_VERSION = '';");
  return crypto.createHash('sha256').update(blank, 'utf8').digest('hex').slice(0, 12);
}

const source = fs.readFileSync(CODE_PATH, 'utf8');

test('CODE_VERSION 跟 Code.gs 的內容相符', () => {
  const want = codeVersion(source);
  assert.strictEqual(source.match(CONSTANT)[1], want,
    "Code.gs 改過了：把 CODE_VERSION 改成 '" + want + "'，推上 GitHub 前記得重新部署 Apps Script");
});

test('公開資料帶有 CODE_VERSION', () => {
  assert.strictEqual(freshEvent().get().version, source.match(CONSTANT)[1]);
});
