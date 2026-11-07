import assert from 'node:assert/strict';
import { createDoc } from '../src/core/doc';
import { audioSegments, clipAlpha, clipTimesAt, mainLayout, overlaySpans, renderOrder, totalDuration } from '../src/core/timeline';
import { MAIN_TRACK, type DocState, type Item } from '../src/core/types';
import { makeClipItem, makeMusicClip, type SourceInfo } from '../src/features/clips';
import { addTrack, cloneClip, cutRange, insertIntoMain, moveClipTo, placeOnOverlay, removeTrackIfEmpty, snapCandidates, snapTime, splitAt, trimBy } from '../src/features/videoEdit';
import { test } from './harness';

const video = (id: string, duration: number): SourceInfo => ({ kind: 'video', id, name: `${id}.mp4`, width: 1920, height: 1080, duration });
const image = (id: string): SourceInfo => ({ kind: 'image', id, name: `${id}.png`, width: 800, height: 600, duration: 0 });

function docWithMain(lengths: number[]): DocState {
  const d = createDoc(1920, 1080);
  lengths.forEach((len, i) => d.items.push({ ...makeClipItem(video(`m${i}`, len), d.canvas, 'main'), id: `c${i}` }));
  return d;
}
const mainIds = (d: DocState) => mainLayout(d).map((s) => s.item.id);
const mainRows = (d: DocState) => mainLayout(d).map((s) => [s.item.type === 'video' ? s.item.mediaId : s.item.id, +s.start.toFixed(3), +s.end.toFixed(3)]);
const withId = (it: Item, id: string) => ({ ...it, id });

test('メインに画像（静止画 5 秒）を置ける。メインのクリップは「収める」が既定', () => {
  const d = docWithMain([3]);
  const img = withId(makeClipItem(image('p'), d.canvas, 'main'), 'img');
  insertIntoMain(d, [img], 3, 0.2);
  assert.deepEqual(mainRows(d), [['m0', 0, 3], ['img', 3, 8]]);
  assert.equal(img.scaleX, Math.min(1920 / 800, 1080 / 600));
});

test('メインへの挿入：境目の近くなら境目に、後ろが詰まる', () => {
  const d = docWithMain([4, 4]);
  insertIntoMain(d, [withId(makeClipItem(video('n', 2), d.canvas, 'main'), 'new')], 4.1, 0.3);
  assert.deepEqual(mainRows(d), [['m0', 0, 4], ['n', 4, 6], ['m1', 6, 10]]);
});

test('メインへの挿入：クリップの途中なら分割して間に入れる。複数はその順に', () => {
  const d = docWithMain([10]);
  const a = withId(makeClipItem(video('a', 1), d.canvas, 'main'), 'A');
  const b = withId(makeClipItem(image('b'), d.canvas, 'main'), 'B');
  insertIntoMain(d, [a, b], 4, 0.2);
  assert.deepEqual(mainRows(d), [['m0', 0, 4], ['a', 4, 5], ['B', 5, 10], ['m0', 10, 16]]);
});

test('オーバーレイ：重ならなければ同じトラック、重なれば別のトラック、なければ新しいトラック', () => {
  const d = docWithMain([10]);
  const t1 = addTrack(d);
  const a = withId(makeClipItem(image('a'), d.canvas, 'overlay'), 'A');
  const b = withId(makeClipItem(image('b'), d.canvas, 'overlay'), 'B');
  const c = withId(makeClipItem(image('c'), d.canvas, 'overlay'), 'C');
  assert.equal(placeOnOverlay(d, a, t1.id, 1), t1.id);
  assert.equal(placeOnOverlay(d, b, t1.id, 6), t1.id); // 1〜6 と 6〜11 は重ならない
  const tc = placeOnOverlay(d, c, t1.id, 3); // 重なる → 新しいトラック（t1 の上）
  assert.notEqual(tc, t1.id);
  assert.deepEqual(d.timeline.overlays.map((t) => t.id), [tc, t1.id]);
  assert.deepEqual(overlaySpans(d, t1.id).map((s) => [s.item.id, s.start, s.end]), [['A', 1, 6], ['B', 6, 11]]);
});

test('複数をオーバーレイに落とす：同じ時刻で別々のトラック', () => {
  const d = docWithMain([10]);
  const t1 = addTrack(d);
  const tracks = ['x', 'y', 'z'].map((k) => placeOnOverlay(d, withId(makeClipItem(image(k), d.canvas, 'overlay'), k), t1.id, 2));
  assert.equal(new Set(tracks).size, 3);
  assert.ok(overlaySpans(d).every((s) => s.start === 2));
});

test('オーバーレイの動画は音声ミュートが既定。ワイプはキャンバスの 4 割に収まる', () => {
  const d = createDoc(1920, 1080);
  const v = makeClipItem(video('w', 5), d.canvas, 'overlay', { x: 100, y: 200 });
  assert.equal(v.type === 'video' && v.muted, true);
  assert.deepEqual([v.cx, v.cy, +(v.crop.w * v.scaleX).toFixed(1)], [100, 200, 768]);
});

test('トラック間の移動：メイン → オーバーレイ（後ろが詰まる）、オーバーレイ → メイン（途中なら分割）', () => {
  const d = docWithMain([3, 4, 5]);
  const t1 = addTrack(d);
  moveClipTo(d, 'c1', { kind: 'overlay', trackId: t1.id, start: 2 }, 0.2);
  assert.deepEqual(mainIds(d), ['c0', 'c2']);
  assert.deepEqual(overlaySpans(d).map((s) => [s.item.id, s.start, s.end]), [['c1', 2, 6]]);
  moveClipTo(d, 'c1', { kind: 'main', t: 5 }, 0.2); // c2 の途中（3〜8）→ 分割して挿入
  assert.deepEqual(mainRows(d), [['m0', 0, 3], ['m2', 3, 5], ['m1', 5, 9], ['m2', 9, 12]]);
  assert.ok(removeTrackIfEmpty(d, t1.id));
});

test('メイン内の移動は境目への並べ替え（分割しない）', () => {
  const d = docWithMain([3, 4, 5]);
  moveClipTo(d, 'c0', { kind: 'main', t: 11 }, 0.2);
  assert.deepEqual(mainIds(d), ['c1', 'c2', 'c0']);
});

test('新しいトラックへの移動・空のトラックだけ削除できる', () => {
  const d = docWithMain([5]);
  const t1 = addTrack(d);
  placeOnOverlay(d, withId(makeClipItem(image('a'), d.canvas, 'overlay'), 'A'), t1.id, 0);
  moveClipTo(d, 'A', { kind: 'newTrack', start: 1 }, 0.2);
  assert.equal(d.timeline.overlays.length, 2);
  assert.equal(d.timeline.overlays[0].id, (d.items.find((it) => it.id === 'A')!.clip!.track));
  assert.equal(removeTrackIfEmpty(d, d.timeline.overlays[0].id), false);
  assert.equal(removeTrackIfEmpty(d, t1.id), true);
});

test('複製（Alt+ドラッグ）：新しい ID で元はそのまま', () => {
  const d = docWithMain([3]);
  const orig = d.items[0];
  const copy = cloneClip(orig);
  insertIntoMain(d, [copy], 3, 0.2);
  assert.notEqual(copy.id, orig.id);
  assert.deepEqual(mainRows(d), [['m0', 0, 3], ['m0', 3, 6]]);
});

test('吸着：境目・再生位置・先頭。クリップの終わりも吸着する。範囲外は吸着しない', () => {
  const d = docWithMain([3, 4]);
  const cands = snapCandidates(d, 5.5);
  assert.deepEqual([...cands].sort((a, b) => a - b), [0, 3, 5.5, 7]);
  assert.deepEqual(snapTime(2.9, 1, cands, 0.2), { t: 3, snapped: 3 });
  assert.deepEqual(snapTime(4.4, 1, cands, 0.2), { t: 4.5, snapped: 5.5 }); // 終わりが再生位置に
  assert.deepEqual(snapTime(0.15, 1, cands, 0.2), { t: 0, snapped: 0 });
  assert.equal(snapTime(1.5, 0.5, cands, 0.2).snapped, null);
});

test('メインの画像の分割・トリム・範囲カット', () => {
  const d = createDoc(1920, 1080);
  insertIntoMain(d, [withId(makeClipItem(image('p'), d.canvas, 'main'), 'P')], 0, 0.2);
  assert.ok(splitAt(d, 2));
  assert.deepEqual(mainRows(d).map((r) => [r[1], r[2]]), [[0, 2], [2, 5]]);
  const first = d.items[0] as Item & { clip: NonNullable<Item['clip']> };
  trimBy(d, structuredClone(first), 'end', 1.5);
  assert.deepEqual(mainRows(d).map((r) => [r[1], r[2]]), [[0, 3.5], [3.5, 6.5]]);
  cutRange(d, 1, 4);
  assert.deepEqual(mainRows(d).map((r) => [r[1], r[2]]), [[0, 1], [1, 3.5]]);
});

test('オーバーレイの開始側のトリムは終わりの時刻を変えない・先頭より前には伸ばせない', () => {
  const d = docWithMain([10]);
  const t1 = addTrack(d);
  const a = withId(makeClipItem(image('a'), d.canvas, 'overlay'), 'A');
  placeOnOverlay(d, a, t1.id, 2);
  const orig = structuredClone(d.items.find((x) => x.id === 'A')!) as Item & { clip: NonNullable<Item['clip']> };
  trimBy(d, orig, 'start', 1);
  assert.deepEqual(overlaySpans(d).map((s) => [s.start, s.end]), [[3, 7]]);
  trimBy(d, orig, 'start', -5);
  assert.deepEqual(overlaySpans(d).map((s) => [s.start, s.end]), [[0, 7]]);
});

test('表示：メインとオーバーレイを同時に、フェードと不透明度を反映、描く順はメイン → 下のトラック → 上のトラック', () => {
  const d = docWithMain([10]);
  const low = addTrack(d);
  const high = addTrack(d); // 一番上
  const a = withId(makeClipItem(image('a'), d.canvas, 'overlay'), 'A');
  const b = withId(makeClipItem(image('b'), d.canvas, 'overlay'), 'B');
  placeOnOverlay(d, b, high.id, 0);
  placeOnOverlay(d, a, low.id, 0);
  a.clip!.fadeIn = 2;
  a.clip!.opacity = 0.5;
  const times = clipTimesAt(d, 1);
  assert.deepEqual([...times.keys()].sort(), ['A', 'B', 'c0']);
  assert.equal(clipAlpha(a, times.get('A')), 0.25);
  assert.deepEqual(renderOrder(d).map((it) => it.id), ['c0', 'A', 'B']);
  // 非表示のトラックは表示しない
  d.timeline.overlays.find((t) => t.id === high.id)!.visible = false;
  assert.equal(clipTimesAt(d, 1).has('B'), false);
});

test('音声：メイン・ミュートしていないオーバーレイの動画・音楽。長さは音楽の終わりまで', () => {
  const d = docWithMain([5]);
  const t1 = addTrack(d);
  const w = makeClipItem(video('w', 3), d.canvas, 'overlay');
  placeOnOverlay(d, w, t1.id, 1);
  d.timeline.music.push(makeMusicClip({ kind: 'audio', id: 'bgm', name: 'bgm.mp3', width: 0, height: 0, duration: 8 }, 0));
  assert.deepEqual(audioSegments(d).map((s) => s.mediaId), ['m0', 'bgm']);
  if (w.type === 'video') w.muted = false;
  assert.deepEqual(audioSegments(d).map((s) => s.mediaId).sort(), ['bgm', 'm0', 'w']);
  assert.equal(totalDuration(d), 8);
  assert.equal(mainLayout(d)[0].track, MAIN_TRACK);
});
