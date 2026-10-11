import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// Read-only deployment smoke check. Never creates devices, messages or files.
const local = 'http://127.0.0.1:3939';
const headers = { 'User-Agent': 'Linchuan/1.0 DeploymentCheck' };
const get = (url: string, extra: Record<string, string> = {}) =>
  fetch(url, {
    headers: { ...headers, ...extra },
    signal: AbortSignal.timeout(20000),
  });
const infoResponse = await get(`${local}/api/info`);
assert.equal(infoResponse.status, 200);
const info = (await infoResponse.json()) as {
  publicUrl?: string;
  urls: string[];
  persistent: boolean;
  maxFileBytes: number | null;
};
assert.equal(info.persistent, true);
assert.equal(info.maxFileBytes, null);
const hostResponse = await get(`${local}/api/host`, { 'X-Linchuan-Host': '1' });
assert.equal(hostResponse.status, 200);
const host = (await hostResponse.json()) as {
  code: string;
  internet: string;
};
assert.match(host.code, /^\d{6}$/);
if (info.publicUrl) assert.equal(host.internet, 'connected');
const html = await fs.readFile('dist/index.html', 'utf8');
const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
  (match) => match[1],
);
assert.ok(
  assets.some((asset) => asset.startsWith('/assets/') && asset.endsWith('.js')),
);
const hashes = new Map<string, string>();
for (const asset of assets)
  hashes.set(
    asset,
    crypto
      .createHash('sha256')
      .update(await fs.readFile(`dist${asset}`))
      .digest('hex'),
  );
const targets = [local, info.urls[0], info.publicUrl].filter(
  (url): url is string => !!url,
);
for (const base of new Set(targets)) {
  const page = await get(base);
  assert.equal(page.status, 200, `${base} 页面不可用`);
  const liveHtml = await page.text();
  for (const [asset, expected] of hashes) {
    assert.ok(liveHtml.includes(asset), `${base} 未提供当前前端 ${asset}`);
    const bundle = await get(base + asset);
    assert.equal(bundle.status, 200);
    assert.equal(
      crypto
        .createHash('sha256')
        .update(Buffer.from(await bundle.arrayBuffer()))
        .digest('hex'),
      expected,
    );
  }
  assert.equal((await get(`${base}/api/messages`)).status, 401);
  if (base !== local)
    assert.equal(
      (await get(`${base}/api/host`, { 'X-Linchuan-Host': '1' })).status,
      403,
    );
  console.log(`${base}：当前页面及前端哈希一致，未登录聊天访问被拒绝。`);
}
console.log('部署只读检查通过；未创建测试设备或用户内容。');
