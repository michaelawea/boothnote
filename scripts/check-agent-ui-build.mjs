#!/usr/bin/env node
/** 校验实际产物，防止开关只隐藏界面或测试版又进入默认离线下载。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps/capture-pwa');
const temporary = mkdtempSync(join(tmpdir(), 'boothnote-agent-ui-build-'));

try {
  for (const enabled of ['1', '0']) {
    const output = join(temporary, enabled);
    const build = spawnSync(process.execPath, [join(app, 'node_modules/vite/bin/vite.js'),
      'build', '--outDir', output], {
      cwd: app, env: { ...process.env, VITE_ASSISTANT_UI_ENABLED: enabled }, encoding: 'utf8',
    });
    if (build.status !== 0) {
      process.stderr.write(build.stdout ?? '');
      process.stderr.write(build.stderr ?? '');
      throw new Error(`Assistant UI build ${enabled} failed`);
    }
    const assets = readdirSync(join(output, 'assets'));
    const chunks = assets.filter((name) => /^AssistantThreadView-.+\.js$/.test(name));
    assert.equal(chunks.length > 0, enabled === '1', 'Disabled builds must omit the assistant-ui chunk');
    const worker = readFileSync(join(output, 'sw.js'), 'utf8');
    const manifest = /precacheAndRoute\(\[([\s\S]*?)\]/.exec(worker);
    assert.ok(manifest, 'Generated worker must contain a precache manifest');
    assert.ok(!manifest[1].includes('AssistantThreadView-'), 'The test interface must load on demand');
    for (const name of assets.filter((name) => name.endsWith('.js') && !chunks.includes(name))) {
      const javascript = readFileSync(join(output, 'assets', name), 'utf8');
      if (enabled === '0') assert.ok(!/AssistantThreadView-[^/]+\.js/.test(javascript),
        'Disabled builds must not retain the lazy import');
    }
    console.log(`assistant-ui=${enabled}: chunk and precache checks passed`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
