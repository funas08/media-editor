// 設定欄で使う小さなUI部品

type Child = Node | string | null | undefined | false;

/** 要素を作る小さなヘルパー。on〇〇 はイベントリスナーとして登録する */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'title' || k === 'for' || k === 'role') el.setAttribute(k, String(v));
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

/** ラベル付きの1行 */
export function row(label: string, ...content: Child[]): HTMLElement {
  return h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), h('div', { class: 'row-content' }, ...content));
}

/** 見出し付きのまとまり */
export function group(title: string | null, ...content: Child[]): HTMLElement {
  return h('div', { class: 'group' }, title ? h('div', { class: 'group-title' }, title) : null, ...content);
}

export function hint(text: string): HTMLElement {
  return h('p', { class: 'hint' }, text);
}

export interface NumberField {
  el: HTMLElement;
  input: HTMLInputElement;
  set(v: number): void;
}

export interface NumberOpts {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** 小数点以下の桁数（表示用） */
  digits?: number;
  /** 確定時（Enter・フォーカスを外したとき） */
  onChange: (v: number) => void;
}

/** 数値入力欄。入力中（フォーカス中）は外からの値の更新で上書きしない */
export function numberInput(o: NumberOpts): NumberField {
  const fmt = (v: number) => {
    const d = o.digits ?? 0;
    return d === 0 ? String(Math.round(v)) : String(Number(v.toFixed(d)));
  };
  const input = h('input', { type: 'number', class: 'num', value: fmt(o.value) }) as HTMLInputElement;
  if (o.min !== undefined) input.min = String(o.min);
  if (o.max !== undefined) input.max = String(o.max);
  input.step = String(o.step ?? 1);
  input.addEventListener('change', () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) return;
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    input.value = fmt(v);
    o.onChange(v);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') input.blur();
  });
  const el = h('span', { class: 'num-wrap' }, input, o.unit ? h('span', { class: 'unit' }, o.unit) : null);
  return {
    el,
    input,
    set(v: number) {
      if (document.activeElement !== input) input.value = fmt(v);
    },
  };
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  title?: string;
}

/** 横並びの切り替えボタン */
export function segmented<T extends string>(choices: Choice<T>[], value: T, onChange: (v: T) => void): { el: HTMLElement; set(v: T): void } {
  const buttons = choices.map((c) =>
    h('button', { class: 'seg-btn', type: 'button', title: c.title, onclick: () => onChange(c.value), onmousedown: (e: MouseEvent) => e.preventDefault() }, c.label),
  );
  const el = h('div', { class: 'segmented' }, ...buttons);
  const set = (v: T) => buttons.forEach((b, i) => b.classList.toggle('active', choices[i].value === v));
  set(value);
  return { el, set };
}

export function selectInput<T extends string>(choices: Choice<T>[], value: T, onChange: (v: T) => void): { el: HTMLSelectElement; set(v: T): void } {
  const el = h('select', { class: 'select' }, ...choices.map((c) => h('option', { value: c.value }, c.label))) as HTMLSelectElement;
  el.value = value;
  el.addEventListener('change', () => {
    onChange(el.value as T);
    // 選んだ後はフォーカスを外し、キーボードショートカットが効くようにする
    el.blur();
  });
  return {
    el,
    set(v: T) {
      el.value = v;
    },
  };
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): { el: HTMLElement; input: HTMLInputElement; set(v: boolean): void } {
  const input = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label', { class: 'check' }, input, h('span', {}, label));
  return {
    el,
    input,
    set(v: boolean) {
      input.checked = v;
    },
  };
}

export function button(label: string, onClick: () => void, opts: { primary?: boolean; icon?: string; title?: string; danger?: boolean } = {}): HTMLButtonElement {
  const cls = ['btn', opts.primary ? 'primary' : '', opts.danger ? 'danger' : ''].filter(Boolean).join(' ');
  const b = h('button', { class: cls, type: 'button', title: opts.title, onclick: onClick, onmousedown: (e: MouseEvent) => e.preventDefault() }) as HTMLButtonElement;
  if (opts.icon) b.append(h('span', { class: 'icon', html: opts.icon }));
  if (label) b.append(h('span', {}, label));
  return b;
}

/** 文字だけの表示（値を後から更新できる） */
export function text(initial = '', cls = 'value'): { el: HTMLElement; set(v: string): void } {
  const el = h('span', { class: cls }, initial);
  return {
    el,
    set(v: string) {
      if (el.textContent !== v) el.textContent = v;
    },
  };
}

/** アイコンだけのボタン（整列など） */
export function iconButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick: onClick, html: icon }) as HTMLButtonElement;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}
