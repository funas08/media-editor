import assert from 'node:assert/strict';
import { createDoc, createImageItem } from '../src/core/doc';
import { applyArrange, formatCellSize, suggestGrid } from '../src/features/arrange';
import { test } from './harness';

const grid = (n: number, w: number, h: number) => {
  const g = suggestGrid(n, w, h, 16 / 9);
  return `${g.rows}x${g.cols}`;
};

test('FHD 4枚を WQHD に並べると 2×2', () => assert.equal(grid(4, 2560, 1440), '2x2'));
test('枚数ごとの自動提案（横長キャンバス）', () => {
  assert.deepEqual([1, 2, 3, 5, 6, 9, 12].map((n) => grid(n, 2560, 1440)), ['1x1', '1x2', '2x2', '2x3', '2x3', '3x3', '3x4']);
});

test('収める：1セル 1280×720・ファイル名の自然順', () => {
  const doc = createDoc(2560, 1440);
  ['b10.png', 'a2.png', 'a10.png', 'c.png'].forEach((name, i) => doc.items.push(createImageItem({ id: `a${i}`, name, width: 1920, height: 1080 }, 0, 0)));
  applyArrange(doc, doc.items.map((it) => it.id), { rows: 2, cols: 2, gap: 0, margin: 0, mode: 'fit', order: 'name' });
  const byName = Object.fromEntries(doc.items.map((it) => [it.name, [it.cx, it.cy, it.crop.w * it.scaleX, it.crop.h * it.scaleY]]));
  assert.deepEqual(byName['a2.png'], [640, 360, 1280, 720]);
  assert.deepEqual(byName['a10.png'], [1920, 360, 1280, 720]);
  assert.deepEqual(byName['b10.png'], [640, 1080, 1280, 720]);
  assert.deepEqual(byName['c.png'], [1920, 1080, 1280, 720]);
});

test('埋める：4:3 の画像を 16:9 のセルに中央で切り抜き', () => {
  const doc = createDoc(2560, 1440);
  doc.items.push(createImageItem({ id: 'p', name: 'p', width: 1600, height: 1200 }, 0, 0));
  applyArrange(doc, [doc.items[0].id], { rows: 2, cols: 2, gap: 10, margin: 20, mode: 'fill', order: 'layer' });
  const it = doc.items[0];
  assert.equal(it.crop.w, 1600);
  assert.ok(Math.abs(it.crop.w / it.crop.h - 1255 / 695) < 1e-9);
  assert.equal(Math.round(it.crop.w * it.scaleX), 1255);
});

test('1セルのサイズ表示', () => {
  assert.equal(formatCellSize(1280, 720), '1280 × 720');
  assert.equal(formatCellSize(2560 / 3, 720), '853.3 × 720');
});
