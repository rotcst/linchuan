import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Pinned official Cloudflare Windows x64 release. No account credentials needed.
const version = '2026.10.0';
const expected =
  '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c';
const url = `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`;
const directory = path.resolve('runtime');
const target = path.join(directory, 'cloudflared.exe');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(directory, { recursive: true });
let current;
try {
  current = await fs.readFile(target);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (current && hash(current) === expected)
  console.log(`cloudflared ${version}: existing binary verified.`);
else {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok)
    throw new Error(
      `Official runtime download failed: HTTP ${response.status}`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expected)
    throw new Error('Official runtime checksum mismatch; nothing installed.');
  const temporary = path.join(
    directory,
    `cloudflared-${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  console.log(`cloudflared ${version}: downloaded and verified.`);
}
