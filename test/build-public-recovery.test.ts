import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPublicRecoveryDirectory } from '../scripts/build-public-recovery.js';
import { createPublicRecoveryPackage } from '../server/public-recovery.js';

test('builds an isolated target-specific recovery directory with pinned hashes', async () => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-recovery-builder-'),
  );
  try {
    const packet = path.join(root, 'packet.json');
    const node = path.join(root, 'node.exe');
    const output = path.join(root, 'out');
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const token = Buffer.from(
      JSON.stringify({
        a: 'synthetic-account',
        t: 'synthetic-tunnel',
        s: 'secret',
      }),
    ).toString('base64url');
    const packetText = createPublicRecoveryPackage(
      {
        groupId: 'synthetic-group',
        hostGeneration: 1,
        hostDeviceId: 'synthetic-host',
        publicKey: (
          publicKey.export({ format: 'der', type: 'spki' }) as Buffer
        ).toString('base64'),
        port: 3939,
      },
      {
        publicUrl: 'https://transfer.example.test',
        accountId: 'synthetic-account',
        tunnelId: 'synthetic-tunnel',
        zoneId: 'synthetic-zone',
        dnsRecordId: null,
        token,
      },
    );
    await fsp.writeFile(packet, packetText);
    await fsp.writeFile(node, Buffer.from('synthetic bundled node'));
    const result = await buildPublicRecoveryDirectory(packet, node, output);
    const names = (await fsp.readdir(output)).sort();
    assert.deepEqual(
      names,
      [
        '恢复公网.cjs',
        '恢复公网.cmd',
        '恢复公网.ps1',
        '公网恢复包.json',
      ].sort(),
    );
    assert.equal(
      (await fsp.readFile(path.join(output, '公网恢复包.json'))).equals(
        await fsp.readFile(packet),
      ),
      true,
    );
    const ps = await fsp.readFile(path.join(output, '恢复公网.ps1'));
    assert.equal(ps[0], 0xef);
    assert.equal(ps[1], 0xbb);
    assert.equal(ps[2], 0xbf);
    const cmd = await fsp.readFile(path.join(output, '恢复公网.cmd'), 'ascii');
    assert.match(cmd, new RegExp(result.packageHash));
    assert.match(cmd, new RegExp(result.programHash));
    assert.match(cmd, new RegExp(result.nodeHash));
    assert.equal(
      [...Buffer.from(cmd)].every((byte) => byte < 128),
      true,
    );
    assert.equal(cmd.includes('%*'), false);
    await assert.rejects(
      () =>
        buildPublicRecoveryDirectory(
          '\\\\server\\share\\packet.json',
          node,
          path.join(root, 'unc'),
        ),
      /网络路径/,
    );
    await assert.rejects(
      () => buildPublicRecoveryDirectory(packet, node, output),
      /全新的/,
    );
    const plaintextPacket = path.join(root, 'plaintext.json');
    const invalidOutput = path.join(root, 'invalid-output');
    await fsp.writeFile(
      plaintextPacket,
      JSON.stringify({ token: 'synthetic-secret' }),
    );
    await assert.rejects(
      () => buildPublicRecoveryDirectory(plaintextPacket, node, invalidOutput),
      /有效恢复包/,
    );
    await assert.rejects(() => fsp.stat(invalidOutput), { code: 'ENOENT' });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('rejects symlinked recovery inputs when the platform permits creating one', async (t) => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-recovery-link-'),
  );
  try {
    const target = path.join(root, 'packet.json');
    const link = path.join(root, 'packet-link.json');
    const node = path.join(root, 'node.exe');
    await fsp.writeFile(target, '{}');
    await fsp.writeFile(node, 'node');
    try {
      await fsp.symlink(target, link);
    } catch {
      t.skip('当前测试账户不能创建符号链接。');
      return;
    }
    await assert.rejects(
      () => buildPublicRecoveryDirectory(link, node, path.join(root, 'out')),
      /链接/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
