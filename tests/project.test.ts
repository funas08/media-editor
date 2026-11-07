import assert from 'node:assert/strict';
import { createDoc } from '../src/core/doc';
import { parseProject } from '../src/io/project';
import { test } from './harness';

const good = { app: 'image-editor', version: 1, savedAt: '', doc: createDoc(), assets: [] };

test('正しい形式は読める', () => {
  assert.equal(parseProject(JSON.stringify(good)).doc.canvas.width, 2560);
});
test('不正な形式は日本語のメッセージで拒否', () => {
  assert.throws(() => parseProject('{x'), /JSON として読めません/);
  assert.throws(() => parseProject(JSON.stringify({ ...good, app: 'other' })), /プロジェクトファイルではありません/);
  assert.throws(() => parseProject(JSON.stringify({ ...good, version: 99 })), /新しいバージョン/);
  assert.throws(() => parseProject(JSON.stringify({ ...good, doc: { canvas: { width: 0, height: 1 }, items: [] } })), /壊れています/);
});
