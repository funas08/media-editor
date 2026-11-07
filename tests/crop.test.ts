import assert from 'node:assert/strict';
import { createDoc, createImageItem, normalizeDoc } from '../src/core/doc';
import { itemBounds } from '../src/core/geometry';
import type { DocState, ImageItem } from '../src/core/types';
import { clampRect, docToSource, fitAspect, maxCenteredRect, resizeCropRect, sourceToDoc, withCrop } from '../src/features/crop';
import { fitCanvasToItems } from '../src/features/transform';
import { adjustToFilter } from '../src/render/imageRenderer';
import { DEFAULT_ADJUST } from '../src/core/doc';
import { near, test } from './harness';

const W = 1920;
const H = 1080;
const r0 = { x: 100, y: 100, w: 400, h: 300 };
const free = { aspect: null, fromCenter: false };

function item(rot: number, fx: boolean, fy: boolean): ImageItem {
  const it = createImageItem({ id: 'a', name: 'x', width: W, height: H }, 800, 500, 0.5);
  return { ...it, rotation: rot, flipX: fx, flipY: fy, scaleY: 0.7, crop: { x: 100, y: 50, w: 1000, h: 800 } };
}

test('元画像↔キャンバスの往復変換と、範囲を変えても画像が動かないこと（回転・反転込み）', () => {
  for (const [rot, fx, fy] of [[0, false, false], [37, true, false], [-120, false, true], [90, true, true]] as const) {
    const it = item(rot, fx, fy);
    const p = sourceToDoc(it, 333, 444);
    const q = docToSource(it, p);
    assert.ok(near(q.x, 333) && near(q.y, 444), `往復 rot=${rot}`);
    const p2 = sourceToDoc(withCrop(it, { x: 400, y: 300, w: 500, h: 200 }), 333, 444);
    assert.ok(near(p.x, p2.x) && near(p.y, p2.y), `不動 rot=${rot}`);
  }
});

test('自由：辺は画像の端で止まる・最小 1px', () => {
  const r = resizeCropRect(r0, -1, 0, -50, 0, free, W, H);
  assert.deepEqual([r.x, r.w, r.h], [0, 500, 300]);
  assert.equal(resizeCropRect(r0, 1, 0, 100.5, 0, free, W, H).w, 1);
});

test('比率固定（Shift 相当）：角ハンドルで比率を保ち、反対の角が固定', () => {
  const r = resizeCropRect(r0, 1, 1, 900, 500, { aspect: 16 / 9, fromCenter: false }, W, H);
  assert.ok(near(r.w / r.h, 16 / 9));
  assert.deepEqual([r.x, r.y], [100, 100]);
  const sq = resizeCropRect(r0, 1, 1, 700, 350, { aspect: 1, fromCenter: false }, W, H);
  assert.deepEqual([sq.w, sq.h], [600, 600]);
});

test('比率固定でも画像の外にはみ出さない', () => {
  const r = resizeCropRect(r0, 1, 1, 5000, 5000, { aspect: 16 / 9, fromCenter: false }, W, H);
  assert.ok(r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6);
  assert.ok(near(r.w / r.h, 16 / 9));
});

test('中心固定（Alt 相当）：中心が動かず両側へ広がる', () => {
  const r = resizeCropRect(r0, 1, 0, 450, 0, { aspect: null, fromCenter: true }, W, H);
  assert.deepEqual([r.x + r.w / 2, r.y + r.h / 2, r.w, r.h], [300, 250, 300, 300]);
  // 反対側を越えてドラッグしても幅は距離の2倍
  const r2 = resizeCropRect(r0, 1, 0, 100, 0, { aspect: null, fromCenter: true }, W, H);
  assert.equal(r2.w, 400);
});

test('中心固定は画像の端までで止まる（中心は動かない）', () => {
  const r = resizeCropRect(r0, 1, 1, 5000, 5000, { aspect: null, fromCenter: true }, W, H);
  assert.deepEqual([r.x, r.y, r.x + r.w / 2, r.y + r.h / 2], [0, 0, 300, 250]);
});

test('Shift+Alt 相当：比率固定かつ中心固定', () => {
  const r = resizeCropRect(r0, 1, 1, 600, 500, { aspect: 1, fromCenter: true }, W, H);
  assert.ok(near(r.w, r.h));
  assert.deepEqual([r.x + r.w / 2, r.y + r.h / 2], [300, 250]);
  assert.ok(r.x >= 0 && r.y >= 0);
});

test('プリセット：中央に最大の正方形（横長・縦長）', () => {
  assert.deepEqual(maxCenteredRect(1920, 1080, 1), { x: 420, y: 0, w: 1080, h: 1080 });
  assert.deepEqual(maxCenteredRect(1080, 1920, 1), { x: 0, y: 420, w: 1080, h: 1080 });
});

test('比率を変えると中心を保って収まる最大の範囲／範囲外は収める', () => {
  assert.deepEqual(fitAspect({ x: 0, y: 0, w: W, h: H }, 1, W, H), { x: 420, y: 0, w: 1080, h: 1080 });
  assert.deepEqual(clampRect({ x: 1800, y: -20, w: 300, h: 2000 }, W, H), { x: 1620, y: 0, w: 300, h: 1080 });
});

test('古いプロジェクト（cropShape なし）は四角形として扱う', () => {
  const doc = createDoc();
  const it = createImageItem({ id: 'a', name: 'x', width: 10, height: 10 }, 0, 0) as Partial<ImageItem>;
  delete it.cropShape;
  doc.items.push(it as ImageItem);
  normalizeDoc(doc as DocState);
  assert.equal((doc.items[0] as ImageItem).cropShape.kind, 'rect');
});

test('キャンバスを選択した画像に合わせる（丸いアイコン画像の流れ）', () => {
  const doc = createDoc(2560, 1440);
  const a = createImageItem({ id: 'a', name: 'a', width: W, height: H }, 1280, 720);
  const b = createImageItem({ id: 'b', name: 'b', width: 100, height: 100 }, 100, 100);
  doc.items.push(a, b);
  // 正円にトリミングした状態（中央の 1080×1080）
  Object.assign(a, withCrop(a, maxCenteredRect(W, H, 1)), { cropShape: { kind: 'ellipse', radius: 0 } });
  assert.ok(fitCanvasToItems(doc, [a.id]));
  assert.deepEqual([doc.canvas.width, doc.canvas.height], [1080, 1080]);
  assert.deepEqual(itemBounds(doc.items[0]), { x: 0, y: 0, w: 1080, h: 1080 });
  // 選択がなければ何もしない
  assert.equal(fitCanvasToItems(doc, []), false);
});

test('色調補正のフィルター文字列', () => {
  assert.equal(adjustToFilter({ brightness: 120, contrast: 100, saturate: 0, hue: 30, grayscale: 0, blur: 2 }, 0.5), 'brightness(120%) saturate(0%) hue-rotate(30deg) blur(1px)');
  assert.equal(adjustToFilter(DEFAULT_ADJUST, 1), 'none');
});
