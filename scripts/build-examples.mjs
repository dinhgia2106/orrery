// Compile every sketch in examples/ for the Arduino Uno and copy the .hex into public/examples/.
// Needs arduino-cli on PATH with the AVR core and the Servo library:
//   arduino-cli core install arduino:avr && arduino-cli lib install Servo
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = join(root, 'public', 'examples');
mkdirSync(out, { recursive: true });

for (const name of readdirSync(join(root, 'examples'))) {
  const build = mkdtempSync(join(tmpdir(), `orrery-${name}-`));
  console.log(`compiling ${name}`);
  execFileSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', '--output-dir', build, join(root, 'examples', name)], {
    stdio: 'inherit',
  });
  copyFileSync(join(build, `${name}.ino.hex`), join(out, `${name}.hex`));
}
console.log(`hex files written to ${out}`);
