// 小さなテストの仕組み（追加のライブラリなし）。scripts/run-tests.mjs から実行する

type TestFn = () => void | Promise<void>;
const queue: { name: string; fn: TestFn }[] = [];

export function test(name: string, fn: TestFn): void {
  queue.push({ name, fn });
}

/** 登録されたテストを取り出す（ランナー用） */
export function takeTests(): { name: string; fn: TestFn }[] {
  return queue.splice(0);
}

/** 浮動小数の比較 */
export function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}
