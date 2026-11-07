import assert from 'node:assert/strict';
import { createDoc, createImageItem, createVideoItem } from '../src/core/doc';
import { totalDuration, videoTrackLayout } from '../src/core/timeline';
import type { VideoItem } from '../src/core/types';
import { cutRange, moveClip, splitAt, trimClip } from '../src/features/videoEdit';
import { near, test } from './harness';

function doc(durations: number[]) {
  const d = createDoc(1920, 1080);
  durations.forEach((len, i) => d.items.push({ ...createVideoItem({ id: `m${i}`, name: `v${i}`, width: 1920, height: 1080, duration: len }, 960, 540), id: `v${i}` }));
  d.items.push({ ...createImageItem({ id: 'a', name: 'img', width: 10, height: 10 }, 5, 5), id: 'img' });
  return d;
}
const layout = (d: ReturnType<typeof doc>) => videoTrackLayout(d).map((s) => [s.item.mediaId, +s.item.inPoint.toFixed(3), +s.item.outPoint.toFixed(3), +s.start.toFixed(3), +s.end.toFixed(3)]);

test('分割（S）：再生位置で2つに分かれ、合計の長さは変わらない', () => {
  const d = doc([10, 5]);
  const id = splitAt(d, 4);
  assert.ok(id);
  assert.deepEqual(layout(d), [['m0', 0, 4, 0, 4], ['m0', 4, 10, 4, 10], ['m1', 0, 5, 10, 15]]);
  assert.equal(totalDuration(d), 15);
  // クリップの端では分けない
  assert.equal(splitAt(d, 4), null);
  assert.equal(splitAt(d, 15), null);
});

test('削除すると後ろが詰まる（並び順で自動的に隙間なし）', () => {
  const d = doc([3, 4, 5]);
  d.items = d.items.filter((it) => it.id !== 'v1');
  assert.deepEqual(layout(d), [['m0', 0, 3, 0, 3], ['m2', 0, 5, 3, 8]]);
});

test('トリム：開始・終了を変えると後ろが詰まる。元動画の範囲と最短の長さを守る', () => {
  const d = doc([10, 5]);
  trimClip(d, 'v0', 'start', 2);
  trimClip(d, 'v0', 'end', 7);
  assert.deepEqual(layout(d), [['m0', 2, 7, 0, 5], ['m1', 0, 5, 5, 10]]);
  trimClip(d, 'v0', 'end', 99);
  assert.equal((d.items[0] as VideoItem).outPoint, 10);
  trimClip(d, 'v0', 'start', -5);
  assert.equal((d.items[0] as VideoItem).inPoint, 0);
  trimClip(d, 'v0', 'start', 10);
  assert.ok(near((d.items[0] as VideoItem).inPoint, 9.95));
});

test('範囲カット（I/O）：複数のクリップにまたがる範囲を切り取って詰める', () => {
  const d = doc([4, 4, 4]);
  assert.equal(cutRange(d, 3, 9), 6);
  assert.deepEqual(layout(d), [['m0', 0, 3, 0, 3], ['m2', 1, 4, 3, 6]]);
});

test('範囲カット：1つのクリップの途中を切り取ると前後に分かれる', () => {
  const d = doc([10]);
  cutRange(d, 2, 5);
  assert.deepEqual(layout(d), [['m0', 0, 2, 0, 2], ['m0', 5, 10, 2, 7]]);
});

test('範囲カット：I と O が逆でも同じ・範囲がクリップと一致すれば削除', () => {
  const d = doc([2, 3]);
  cutRange(d, 5, 2);
  assert.deepEqual(layout(d), [['m0', 0, 2, 0, 2]]);
});

test('並べ替え：動画クリップどうしの順番だけが変わり、画像の重なり順は変わらない', () => {
  const d = doc([1, 2, 3]);
  moveClip(d, 'v2', 0);
  assert.deepEqual(d.items.map((it) => it.id), ['v2', 'v0', 'v1', 'img']);
  moveClip(d, 'v2', 99);
  assert.deepEqual(d.items.map((it) => it.id), ['v0', 'v1', 'v2', 'img']);
  assert.deepEqual(layout(d).map((r) => r[0]), ['m0', 'm1', 'm2']);
});

test('再生速度 2 倍のクリップの分割・カットは元動画の時刻で計算する', () => {
  const d = doc([10]);
  (d.items[0] as VideoItem).speed = 2;
  splitAt(d, 2);
  assert.deepEqual(layout(d), [['m0', 0, 4, 0, 2], ['m0', 4, 10, 2, 5]]);
});
