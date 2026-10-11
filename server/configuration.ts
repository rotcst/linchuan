import fs from 'node:fs';
import path from 'node:path';

// The saved configuration is the source of the public entry even when the
// tunnel is disabled. Do not depend on a launcher exporting PUBLIC_URL.
export function readPublicUrl(dataDir: string, environmentUrl?: string) {
  let value: unknown = environmentUrl?.trim() || undefined;
  try {
    const text = fs.readFileSync(path.join(dataDir, 'cloudflare.json'), 'utf8');
    const configuration = JSON.parse(text.replace(/^\uFEFF/, '')) as {
      publicUrl?: unknown;
    };
    value = configuration.publicUrl ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('无法读取公网入口配置，请检查 cloudflare.json。', {
        cause: error,
      });
  }
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new Error('公网入口配置必须包含有效的 HTTPS 地址。');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('公网入口配置必须包含有效的 HTTPS 地址。');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('公网入口配置必须包含无凭据的 HTTPS 地址。');
  return url.origin;
}
