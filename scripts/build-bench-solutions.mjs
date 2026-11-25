// Compiles the benchmark's reference solutions (bench/solutions/*.ino) into .hex files next to them, so the
// grader tests run in CI without arduino-cli.   npm run build:bench-solutions
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from './arduino-cli.mjs';

const dir = join(import.meta.dirname, '..', 'bench', 'solutions');
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.ino')).sort()) {
  const r = await compile(readFileSync(join(dir, file), 'utf8'));
  if (!r.ok) {
    failed++;
    console.error(`✗ ${file}\n${r.log}`);
    continue;
  }
  writeFileSync(join(dir, file.replace(/\.ino$/, '.hex')), r.hex);
  console.log(`✓ ${file}`);
}
process.exit(failed ? 1 : 0);
