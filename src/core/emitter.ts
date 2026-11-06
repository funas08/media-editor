// シンプルなイベント通知

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  /** 購読する。戻り値の関数を呼ぶと解除 */
  on(fn: (value: T) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(value: T): void {
    for (const fn of [...this.listeners]) fn(value);
  }
}
