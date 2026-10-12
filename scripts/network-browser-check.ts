import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { createLanServer } from '../server/app.js';

// Real Chromium DTLS transport; no clipboard, production host or tunnel credentials.
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'linchuan-network-browser-'),
);
const server = createLanServer({
  port: 0,
  host: '127.0.0.1',
  dataDir: directory,
  joinCode: '654321',
  publicDir: path.resolve('dist'),
});
// This listener sees the bridge's loopback HTTP requests. Browser traffic uses
// the separate TLS listener, including any service-worker HTTPS fallback.
const directFileRequests: string[] = [];
server.server.on('request', (request) => {
  if (
    request.method === 'GET' &&
    /^\/api\/files\/[\w-]+$/.test(request.url || '')
  )
    directFileRequests.push(request.url!);
});
await server.start();
const base = server
  .getSecureUrls()
  .find((value) => value.startsWith('https://127.0.0.1:'))!;
const browser = await chromium.launch({
  headless: true,
  args: ['--ignore-certificate-errors'],
}); // Isolated self-signed fixture only.
const errors: string[] = [];
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const httpDataRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(messages|transfers)(?:[/?]|$)/.test(request.url()))
      httpDataRequests.push(
        request.method() + ' ' + new URL(request.url()).pathname,
      );
  });
  await page.goto(base);
  await page.getByLabel('设备名称', { exact: true }).fill('RTC Phone QA');
  await page.getByRole('button', { name: '手机', exact: true }).click();
  await page.getByLabel('6 位连接码').fill('654321');
  await page.getByRole('button', { name: '进入聊天室' }).click();
  await expect(page.locator('.header-connection')).toContainText('局域网连接', {
    timeout: 15000,
  });
  const initialRequests = httpDataRequests.length;
  await page
    .getByRole('textbox', { name: '输入消息' })
    .fill('Encrypted direct message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(
    page
      .getByRole('log')
      .getByText('Encrypted direct message', { exact: true }),
  ).toBeVisible();
  const file = crypto.randomBytes(9 * 1024 * 1024 + 19);
  const fileName = 'rtc-large.bin';
  await page.locator('input[type=file]').first().setInputFiles({
    name: fileName,
    mimeType: 'application/octet-stream',
    buffer: file,
  });
  await expect(
    page.locator('.attachment').getByText(fileName, { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.upload-row')).toHaveCount(0, { timeout: 60000 });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  const downloadUrl = await page
    .getByRole('link', { name: '下载 rtc-large.bin' })
    .getAttribute('href');
  const responseEvent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === downloadUrl,
  );
  const downloadHash = await page.evaluate(async (url) => {
    const response = await fetch(url!);
    if (!response.ok) throw new Error('download failed');
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', await response.arrayBuffer()),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
  }, downloadUrl);
  assert(
    (await responseEvent).fromServiceWorker(),
    'large download is streamed through the LAN file bridge',
  );
  assert.equal(
    downloadHash,
    crypto.createHash('sha256').update(file).digest('hex'),
    '9MiB RTC download SHA256',
  );
  assert(
    directFileRequests.includes(downloadUrl!),
    'download reached the authenticated RTC bridge rather than HTTPS fallback',
  );
  assert.equal(
    httpDataRequests.length,
    initialRequests,
    'chat/history/chunk uploads use encrypted RTC, not browser HTTP API',
  );
  const profile = await page.evaluate(() => ({
    profile: JSON.parse(localStorage.getItem('linchuan.profile')!),
    token: localStorage.getItem('linchuan.token'),
  }));
  await page.reload();
  await expect(page.locator('.header-connection')).toContainText('局域网连接', {
    timeout: 15000,
  });
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('linchuan.profile')!),
    ),
    profile.profile,
    'reload preserves device identity',
  );
  // Block new local signaling and reload: HTTPS remains usable with the original identity.
  await page.route('**/api/network/rtc', (route) => route.abort());
  await page.reload();
  await expect(page.locator('.header-connection')).toContainText('互联网连接', {
    timeout: 15000,
  });
  await page
    .getByRole('textbox', { name: '输入消息' })
    .fill('HTTPS fallback message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(
    page.getByRole('log').getByText('HTTPS fallback message', { exact: true }),
  ).toBeVisible();
  assert(
    httpDataRequests.some((value) => value === 'POST /api/messages'),
    'fallback sends through HTTPS',
  );
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('linchuan.profile')!),
    ),
    profile.profile,
    'fallback preserves device identity',
  );
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    'network browser checks passed: real DTLS / 9MiB upload and streaming download SHA-256 / identity / HTTPS fallback',
  );
} finally {
  await browser.close();
  await server.close();
  await fs.rm(directory, { recursive: true, force: true });
}
