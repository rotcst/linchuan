import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readPublicUrl } from '../server/configuration.js';
import { createLanServer } from '../server/app.js';

test('公网入口从持久配置读取，与 PUBLIC_URL 和通道开关无关', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-config-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'cloudflare.json');
  assert.equal(readPublicUrl(directory, ''), '');
  assert.equal(
    readPublicUrl(directory, 'https://environment.example.test/path'),
    'https://environment.example.test',
  );
  for (const bom of ['', '\uFEFF']) {
    await fs.writeFile(
      file,
      bom + JSON.stringify({ publicUrl: 'https://transfer.example.test/path' }),
    );
    for (const environment of [undefined, '', 'https://stale.example.test'])
      assert.equal(
        readPublicUrl(directory, environment),
        'https://transfer.example.test',
      );
  }
});

test('真实 server/index.ts 链路的显式空白会清除已保存公网入口', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-config-clear-'),
  );
  const seed = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: directory,
    joinCode: '123456',
    publicUrl: 'https://stale.example.test',
  });
  await seed.start();
  await seed.close();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        DATA_DIR: directory,
        PORT: '0',
        INTERNET: '0',
        PUBLIC_URL: '   ',
        OPEN_BROWSER: '0',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('启动超时')), 15000);
    let output = '';
    child!.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      const match = output.match(/本机访问: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child!.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child!.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('服务提前退出'));
    });
  });
  const info = (await (await fetch(`${base}/api/info`)).json()) as {
    publicUrl: string | null;
  };
  assert.equal(info.publicUrl, null);
  await fetch(`${base}/api/host/stop`, {
    method: 'POST',
    headers: { 'x-linchuan-host': '1' },
  });
  await exited;
});

test('损坏或含凭据的公网配置明确报错，不静默隐藏入口', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-config-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const configuration of [
    '{',
    '{}',
    JSON.stringify({ publicUrl: 123 }),
    JSON.stringify({ publicUrl: 'http://transfer.example.test' }),
    JSON.stringify({
      publicUrl: 'https://user:password@transfer.example.test',
    }),
  ]) {
    await fs.writeFile(path.join(directory, 'cloudflare.json'), configuration);
    assert.throws(() => readPublicUrl(directory, ''), /公网入口配置/);
  }
});

test('真实服务启动在 PUBLIC_URL 为空、INTERNET=0 时仍返回持久公网入口', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-startup-'),
  );
  await fs.writeFile(
    path.join(directory, 'cloudflare.json'),
    '\uFEFF' + JSON.stringify({ publicUrl: 'https://transfer.example.test' }),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        DATA_DIR: directory,
        PORT: '0',
        INTERNET: '0',
        PUBLIC_URL: '',
        OPEN_BROWSER: '0',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('启动超时')), 15000);
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      const match = output.match(/本机访问: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('服务提前退出'));
    });
  });
  const info = (await (await fetch(`${base}/api/info`)).json()) as {
    publicUrl: string;
    urls: string[];
  };
  assert.equal(info.publicUrl, 'https://transfer.example.test');
  assert.ok(info.urls.includes(info.publicUrl));
  const host = (await (
    await fetch(`${base}/api/host`, { headers: { 'x-linchuan-host': '1' } })
  ).json()) as { publicUrl: string; internet: string };
  assert.equal(host.publicUrl, info.publicUrl);
  assert.equal(host.internet, 'disabled');
  await fetch(`${base}/api/host/stop`, {
    method: 'POST',
    headers: { 'x-linchuan-host': '1' },
  });
  await exited;
});
