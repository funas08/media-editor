import assert from 'node:assert/strict';
import { createDoc, createImageItem, normalizeDoc } from '../src/core/doc';
import { itemBounds } from '../src/core/geometry';
import type { DocState } from '../src/core/types';
import { blankDocument, documentFromImage } from '../src/features/commands';
import { applyCanvasCrop, clampRectTo, fitAspectTo, resizeCropRect } from '../src/features/crop';
import { getStartOptions } from '../src/ui/startOptions';
import '../src/ui/startOptionsBuiltin';
import { test } from './harness';

const r0 = { x: 0, y: 0, w: 2560, h: 1440 };

test('キャンバスの枠はキャンバスの外まで広げられる（左・上はマイナス）', () => {
  const r = resizeCropRect(r0, -1, -1, -300, -200, { aspect: null, fromCenter: false, unbounded: true }, 0, 0);
  assert.deepEqual(r, { x: -300, y: -200, w: 2860, h: 1640 });
  const r2 = resizeCropRect(r0, 1, 0, 4000, 0, { aspect: null, fromCenter: false, unbounded: true }, 0, 0);
  assert.equal(r2.w, 4000);
});

test('キャンバスの枠：Alt で中心固定、Shift+Alt で比率も固定（制限なし）', () => {
  const r = resizeCropRect(r0, 1, 0, 3000, 0, { aspect: null, fromCenter: true, unbounded: true }, 0, 0);
  assert.deepEqual([r.x + r.w / 2, r.w], [1280, 3440]);
  const s = resizeCropRect(r0, 1, 1, 2000, 1500, { aspect: 1, fromCenter: true, unbounded: true }, 0, 0);
  assert.equal(s.w, s.h);
  assert.deepEqual([s.x + s.w / 2, s.y + s.h / 2], [1280, 720]);
});

test('制限なしの比率合わせ・数値入力はマイナス座標を保つ', () => {
  assert.deepEqual(fitAspectTo({ x: -100, y: 0, w: 2000, h: 1000 }, 1, null), { x: 400, y: 0, w: 1000, h: 1000 });
  assert.deepEqual(clampRectTo({ x: -50, y: -60, w: 0, h: 10 }, null), { x: -50, y: -60, w: 1, h: 10 });
});

test('キャンバスのトリミングを確定：サイズが枠に、画像は見た目そのままずれる', () => {
  const doc = createDoc(2560, 1440);
  doc.items.push(createImageItem({ id: 'a', name: 'a', width: 1920, height: 1080 }, 1280, 720));
  const before = itemBounds(doc.items[0]);
  applyCanvasCrop(doc, { x: 320.4, y: -100, w: 1920, h: 1640.2 }, { kind: 'ellipse', radius: 0 });
  assert.deepEqual([doc.canvas.width, doc.canvas.height, doc.canvas.shape.kind], [1920, 1640, 'ellipse']);
  const after = itemBounds(doc.items[0]);
  // 枠の左上（整数にそろえた 320, -100）が原点になる
  assert.deepEqual([after.x - before.x, after.y - before.y], [-320, 100]);
});

test('古いファイル（キャンバスの形なし）は四角形', () => {
  const doc = createDoc() as DocState;
  delete (doc.canvas as Partial<DocState['canvas']>).shape;
  normalizeDoc(doc);
  assert.equal(doc.canvas.shape.kind, 'rect');
});

test('画像を開く：キャンバスが画像のサイズで、画像が (0,0) にぴったり', () => {
  const doc = documentFromImage({ id: 'x', name: 'x.png', width: 1234, height: 567 });
  assert.deepEqual([doc.canvas.width, doc.canvas.height], [1234, 567]);
  assert.deepEqual(itemBounds(doc.items[0]), { x: 0, y: 0, w: 1234, h: 567 });
});

test('白紙から作成：サイズ・背景色・透明', () => {
  const doc = blankDocument({ width: 3840, height: 2160, background: '#112233', transparent: true });
  assert.deepEqual([doc.canvas.width, doc.canvas.height, doc.canvas.background, doc.canvas.transparent, doc.items.length], [3840, 2160, '#112233', true, 0]);
});

test('起動画面の選択肢は登録順（画像を開く・白紙から作成・プロジェクトを開く）', () => {
  assert.deepEqual(getStartOptions().map((o) => o.id), ['open-image', 'blank', 'open-project']);
});
