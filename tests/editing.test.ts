import assert from 'node:assert/strict';
import { createImageItem } from '../src/core/doc';
import { Editor } from '../src/core/Editor';
import { itemSize } from '../src/core/geometry';
import { alignItems, distributeItems } from '../src/features/align';
import { deleteSelected, duplicateSelected, moveLayers, setItemProps } from '../src/features/commands';
import { collectSnapTargets, snapRect } from '../src/features/snap';
import { fitToCanvas, normalizeAngle } from '../src/features/transform';
import { test } from './harness';

function setup(n = 3): Editor {
  const e = new Editor();
  e.update('add', (d) => {
    for (let i = 0; i < n; i++) d.items.push({ ...createImageItem({ id: `a${i}`, name: `n${i}`, width: 200, height: 100 }, 300 + i * 500, 300), id: `i${i}` });
  });
  return e;
}

test('ドラッグ中に何回 preview しても履歴は1件', () => {
  const e = setup();
  e.begin('移動');
  for (let k = 1; k <= 5; k++) e.preview((d) => (d.items[0].cx = 300 + k * 10));
  e.commit();
  assert.equal(e.doc.items[0].cx, 350);
  e.undo();
  assert.equal(e.doc.items[0].cx, 300);
  e.redo();
  assert.equal(e.doc.items[0].cx, 350);
});

test('整列：複数は選択範囲基準、1つはキャンバス基準', () => {
  const e = setup();
  e.update('ずらす', (d) => (d.items[1].cy = 500));
  e.update('整列', (d) => alignItems(d, ['i0', 'i1', 'i2'], 'top'));
  assert.deepEqual(e.doc.items.map((i) => i.cy), [300, 300, 300]);
  e.update('整列', (d) => alignItems(d, ['i0'], 'right'));
  assert.equal(e.doc.items[0].cx, 2560 - 100);
});

test('横に等間隔に分布', () => {
  const e = setup();
  e.update('配置', (d) => {
    d.items[0].cx = 100;
    d.items[1].cx = 1000;
    d.items[2].cx = 1300;
  });
  e.update('分布', (d) => distributeItems(d, ['i0', 'i1', 'i2'], 'h'));
  assert.deepEqual(e.doc.items.map((i) => i.cx), [100, 700, 1300]);
});

test('90°回転した画像は外接矩形で整列', () => {
  const e = setup();
  e.update('回転', (d) => (d.items[0].rotation = 90));
  e.update('整列', (d) => alignItems(d, ['i0'], 'left'));
  assert.equal(Math.round(e.doc.items[0].cx), 50);
});

test('スナップ：端・中央に吸着し、ガイドを返す。軸固定・範囲外', () => {
  const e = setup();
  const tg = collectSnapTargets(e.doc, ['i1']);
  const r = snapRect({ x: 4, y: 716, w: 200, h: 100 }, tg, 7);
  assert.deepEqual([r.dx, r.dy, r.guides.xs.includes(0), r.guides.ys.includes(720)], [-4, 4, true, true]);
  const r2 = snapRect({ x: 4, y: 716, w: 200, h: 100 }, tg, 7, 'x');
  assert.deepEqual([r2.dx, r2.dy], [-4, 0]);
  assert.equal(snapRect({ x: 30, y: 703, w: 200, h: 100 }, tg, 7).dx, 0);
});

test('レイヤーの前面・最前面・最背面', () => {
  const e = setup();
  e.setSelection(['i0']);
  moveLayers(e, 'up');
  assert.deepEqual(e.doc.items.map((i) => i.id), ['i1', 'i0', 'i2']);
  moveLayers(e, 'top');
  assert.deepEqual(e.doc.items.map((i) => i.id), ['i1', 'i2', 'i0']);
  moveLayers(e, 'bottom');
  assert.deepEqual(e.doc.items.map((i) => i.id), ['i0', 'i1', 'i2']);
});

test('複製・削除・ロック中は削除しない', () => {
  const e = setup();
  e.setSelection(['i0']);
  duplicateSelected(e);
  assert.equal(e.doc.items.length, 4);
  assert.equal(e.doc.items[1].name, 'n0 のコピー');
  deleteSelected(e);
  assert.equal(e.doc.items.length, 3);
  setItemProps(e, 'i2', 'ロック', { locked: true });
  e.setSelection(['i2']);
  deleteSelected(e);
  assert.equal(e.doc.items.length, 3);
});

test('キャンバスに収める / 埋める', () => {
  const e = setup();
  e.update('fit', (d) => fitToCanvas(d, ['i1'], 'fit'));
  assert.deepEqual(Object.values(itemSize(e.doc.items[1])), [2560, 1280]);
  e.update('fill', (d) => fitToCanvas(d, ['i1'], 'fill'));
  assert.deepEqual(Object.values(itemSize(e.doc.items[1])), [2880, 1440]);
});

test('角度の正規化', () => {
  assert.deepEqual([normalizeAngle(270), normalizeAngle(-190), normalizeAngle(180)], [-90, 170, 180]);
});
