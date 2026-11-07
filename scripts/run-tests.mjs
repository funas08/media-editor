// tests/**/*.test.ts を Vite の SSR ローダーで読み込んで実行する（Node だけで動くテスト）
import { readdirSync } from 'node:fs';
import { createServer } from 'vite';

const filter = process.argv[2] ?? '';
const files = readdirSync('tests', { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.ts') && f.includes(filter))
  .sort();

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const harness = await server.ssrLoadModule('/tests/harness.ts');
let pass = 0;
let fail = 0;
for (const f of files) {
  console.log(`\n${f}`);
  await server.ssrLoadModule(`/tests/${f.replaceAll('\\', '/')}`);
  for (const t of harness.takeTests()) {
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${t.name}\n      ${e instanceof Error ? e.message.split('\n').join('\n      ') : String(e)}`);
    }
  }
}
await server.close();
console.log(`\n合計：成功 ${pass} / 失敗 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
