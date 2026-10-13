import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  createPublicRecoveryPackage,
  openPublicRecoveryPackage,
} from '../server/public-recovery.js';

function safePath(value: string) {
  let current = path.resolve(value);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error('恢复路径不能包含链接。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function main() {
  const [mode, file, directory, deviceId, portText, expectedHash] =
    process.argv.slice(2);
  if (!file) throw new Error('缺少恢复文件。');
  safePath(file);
  if (mode === 'create') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 65536) throw new Error('恢复输入过大。');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    try {
      const input = JSON.parse(bytes.toString('utf8'));
      fs.writeFileSync(
        file,
        createPublicRecoveryPackage(input.target, input.source),
        {
          flag: 'wx',
        },
      );
    } finally {
      bytes.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
    return;
  }
  if (
    mode !== 'decrypt' ||
    process.stdout.isTTY ||
    process.env.LINCHUAN_RECOVERY_PIPE !== '1' ||
    !directory ||
    !deviceId ||
    !/^[a-f0-9]{64}$/.test(expectedHash ?? '') ||
    !/^\d{4,5}$/.test(portText ?? '')
  )
    throw new Error('恢复参数无效。');
  if (fs.statSync(file).size > 65536) throw new Error('恢复文件过大。');
  const bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new Error('恢复文件校验不通过。');
  safePath(directory);
  const database = path.join(path.resolve(directory), 'linchuan.sqlite');
  safePath(database);
  if (!fs.existsSync(database)) throw new Error('缺少原服务数据库。');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT key,value FROM metadata WHERE key IN ('network.groupId','network.publicKey','network.privateKey','network.hostGeneration','host.deviceId')",
      )
      .all() as { key: string; value: string }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const payload = openPublicRecoveryPackage(bytes.toString('utf8'), {
      groupId: values.get('network.groupId') ?? '',
      hostGeneration: Number(values.get('network.hostGeneration')),
      hostDeviceId: values.get('host.deviceId') ?? '',
      privateKey: values.get('network.privateKey') ?? '',
      port: Number(portText),
    });
    if (values.get('host.deviceId') !== deviceId)
      throw new Error('当前桌面身份不是服务主机。');
    // This is a private parent/child pipe, consumed by the DPAPI wrapper.
    process.stdout.write(
      JSON.stringify({
        configuration: {
          publicUrl: payload.publicUrl,
          accountId: payload.accountId,
          tunnelId: payload.tunnelId,
          zoneId: payload.zoneId,
          dnsRecordId: payload.dnsRecordId,
        },
        token: payload.token,
      }),
    );
  } finally {
    bytes.fill(0);
    db.close();
  }
}

void main().catch(() => {
  console.error('恢复验证失败：请确认目标电脑、设备组、端口和恢复包有效期。');
  process.exitCode = 1;
});
