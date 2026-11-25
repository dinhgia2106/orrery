import { describe, expect, it } from 'vitest';
import dexHex from '../../public/examples/dexterous-hand.hex?raw';
import dexWristHex from '../../public/examples/dexterous-hand-wrist.hex?raw';
import servoSweepHex from '../../public/examples/servo-sweep.hex?raw';
import { runProject } from '../headless/run';
import { cloneProject, parseProject } from './project';
import { PUBLIC_URL, isShareHash, readShareHash, shareHash, shareUrl } from './share';
import { TEMPLATES } from './templates';

const template = (id: string) => cloneProject(TEMPLATES.find((t) => t.id === id)!.project);

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deflate(text: string): Promise<Uint8Array> {
  const s = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

describe('share links', () => {
  it('round-trip a bench with its firmware', async () => {
    const p = template('robot-arm');
    const hash = await shareHash(p, { uno: servoSweepHex });
    expect(isShareHash(hash)).toBe(true);
    const back = await readShareHash(hash);
    expect(back!.project).toEqual(parseProject(JSON.stringify(p)));
    expect(back!.firmware.uno).toBe(servoSweepHex);
  });

  it('pack the 17-servo hand with both boards’ firmware into a compressed link', async () => {
    const p = template('dexterous-hand');
    const hash = await shareHash(p, { uno: dexHex, uno2: dexWristHex });
    const plain = JSON.stringify({ project: p, firmware: { uno: dexHex, uno2: dexWristHex } });
    expect(hash.length).toBeLessThan(plain.length / 2); // measured: 30 133 characters for 93 327 of JSON (3.1×)
    const back = await readShareHash(hash);
    expect(Object.keys(back!.firmware).sort()).toEqual(['uno', 'uno2']);
    expect(back!.project.assembly?.links.length).toBe(p.assembly!.links.length);
  });

  it('give a full URL on the public site, or on another base', async () => {
    const p = template('blink');
    expect(await shareUrl(p)).toMatch(new RegExp(`^${PUBLIC_URL.replace(/[./]/g, '\\$&')}#z=`));
    expect(await shareUrl(p, {}, 'http://localhost:5173/#old')).toMatch(/^http:\/\/localhost:5173\/#z=/);
  });

  it('still open the older #p= links', async () => {
    const p = template('servo-sweep');
    const legacy = `#p=${base64Url(new TextEncoder().encode(JSON.stringify(p)))}`;
    expect((await readShareHash(legacy))!.project.name).toBe(p.name);
  });

  it('drop firmware for boards that are not on the bench, and text that is not Intel HEX', async () => {
    const back = await readShareHash(await shareHash(template('blink'), { uno: 'not hex', uno9: servoSweepHex }));
    expect(back!.firmware).toEqual({});
  });

  it('refuse junk', async () => {
    expect(await readShareHash('#z=AAAA')).toBeNull();
    expect(await readShareHash('#q=abc')).toBeNull();
    const notOurs = `#z=${base64Url(await deflate(JSON.stringify({ format: 'something', version: 1, project: template('blink') })))}`;
    expect(await readShareHash(notOurs)).toBeNull();
  });

  it('refuse a link that unpacks to more than 8 MB', async () => {
    const bomb = `#z=${base64Url(await deflate(JSON.stringify({ format: 'orrery.share', version: 1, pad: ' '.repeat(9 * 1024 * 1024) })))}`;
    expect(bomb.length).toBeLessThan(40_000);
    expect(await readShareHash(bomb)).toBeNull();
  });

  it('a link runs headless exactly as written: the path a tool takes to check what it shares', async () => {
    const back = await readShareHash(await shareHash(template('servo-sweep'), { uno: servoSweepHex }));
    const r = await runProject(back!.project, { seconds: 2, firmware: back!.firmware });
    expect(r.ok).toBe(true);
    expect(Math.max(...r.samples.map((s) => s.devices.servo1.angle as number))).toBeGreaterThan(170);
  });
});
