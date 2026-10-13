import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  createPublicRecoveryPackage,
  openPublicRecoveryPackage,
  type RecoveryConfiguration,
  type RecoveryTarget,
} from '../server/public-recovery.js';

const now = 1_800_000_000_000;

const material = () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: (
      pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
    ).toString('base64'),
    publicKey: (
      pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    ).toString('base64'),
  };
};

const config: RecoveryConfiguration = {
  publicUrl: 'https://transfer.example.test',
  accountId: 'account-1234567890',
  tunnelId: 'tunnel-1234567890',
  zoneId: 'zone-1234567890',
  dnsRecordId: 'dns-1234567890',
};

const token = (overrides: Record<string, string> = {}) =>
  Buffer.from(
    JSON.stringify({
      a: overrides.a ?? config.accountId,
      t: overrides.t ?? config.tunnelId,
      s: overrides.s ?? 'synthetic-secret',
    }),
  ).toString('base64');

const makeTarget = () => {
  const keys = material();
  return {
    keys,
    target: {
      groupId: 'group-1234567890',
      hostGeneration: 7,
      hostDeviceId: 'computer-target',
      publicKey: keys.publicKey,
      port: 42339,
    } satisfies RecoveryTarget,
  };
};

const create = (
  target: RecoveryTarget,
  source = { ...config, token: token() },
) => createPublicRecoveryPackage(target, source, now);

test('public recovery package round-trips and binds target identity', () => {
  const { keys, target } = makeTarget();
  const packed = create(target);
  const recovered = openPublicRecoveryPackage(
    packed,
    { ...target, privateKey: keys.privateKey },
    now + 1000,
  );
  assert.equal(recovered.publicUrl, config.publicUrl);
  assert.equal(recovered.tunnelId, config.tunnelId);
  assert.equal(recovered.token, token());
  assert.equal(recovered.metadata.targetHostGeneration, target.hostGeneration);
});

test('legacy configuration without a recorded DNS id recovers without inventing one', () => {
  const { keys, target } = makeTarget();
  const packed = create(target, {
    ...config,
    dnsRecordId: null,
    token: token(),
  });
  const recovered = openPublicRecoveryPackage(
    packed,
    { ...target, privateKey: keys.privateKey },
    now + 1000,
  );
  assert.equal(recovered.dnsRecordId, null);
  assert.equal(recovered.token, token());
});

test('wrong recipient, generation, host and port are rejected', () => {
  const { keys, target } = makeTarget();
  const packed = create(target);
  const wrongKeys = material();
  for (const altered of [
    {
      ...target,
      privateKey: keys.privateKey,
      hostGeneration: target.hostGeneration + 1,
    },
    { ...target, privateKey: keys.privateKey, hostDeviceId: 'other-host' },
    { ...target, privateKey: keys.privateKey, port: target.port + 1 },
    { ...target, privateKey: wrongKeys.privateKey },
  ])
    assert.throws(() => openPublicRecoveryPackage(packed, altered), /恢复包/);
});

test('AAD, ciphertext, tag, key and metadata tampering are rejected', () => {
  const { keys, target } = makeTarget();
  const packed = JSON.parse(create(target)) as Record<string, unknown>;
  const flip = (value: string) =>
    (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
  for (const field of ['ciphertext', 'tag', 'wrappedKey']) {
    const copy = { ...packed, [field]: flip(packed[field] as string) };
    assert.throws(
      () =>
        openPublicRecoveryPackage(
          JSON.stringify(copy),
          { ...target, privateKey: keys.privateKey },
          now + 1000,
        ),
      /恢复包/,
    );
  }
  const aadCopy = { ...packed, targetPort: target.port + 1 };
  assert.throws(
    () =>
      openPublicRecoveryPackage(
        JSON.stringify(aadCopy),
        { ...target, privateKey: keys.privateKey },
        now + 1000,
      ),
    /恢复包/,
  );
  const unknown = { ...packed, extra: true };
  assert.throws(
    () =>
      openPublicRecoveryPackage(
        JSON.stringify(unknown),
        { ...target, privateKey: keys.privateKey },
        now + 1000,
      ),
    /恢复包字段/,
  );
});

test('configuration and Cloudflare token validation rejects mismatches and unsafe URLs', () => {
  const { target } = makeTarget();
  for (const source of [
    { ...config, publicUrl: 'http://transfer.example.test', token: token() },
    {
      ...config,
      publicUrl: 'https://user:pass@transfer.example.test',
      token: token(),
    },
    {
      ...config,
      publicUrl: 'https://transfer.example.test/path',
      token: token(),
    },
    { ...config, token: token({ a: 'other-account' }) },
    { ...config, token: token({ t: 'other-tunnel' }) },
  ])
    assert.throws(() => create(target, source), /公网入口|通道凭据/);
});

test('expiry, future timestamps and size limits are rejected', () => {
  const { keys, target } = makeTarget();
  const packed = JSON.parse(create(target)) as Record<string, unknown>;
  assert.throws(
    () =>
      openPublicRecoveryPackage(
        JSON.stringify({ ...packed, expiresAt: now - 1 }),
        { ...target, privateKey: keys.privateKey },
        now,
      ),
    /恢复包/,
  );
  assert.throws(
    () =>
      openPublicRecoveryPackage(
        JSON.stringify({ ...packed, createdAt: now + 10 * 60 * 1000 }),
        { ...target, privateKey: keys.privateKey },
        now,
      ),
    /恢复包时间/,
  );
  assert.throws(
    () =>
      openPublicRecoveryPackage(
        'x'.repeat(64 * 1024 + 1),
        { ...target, privateKey: keys.privateKey },
        now,
      ),
    /恢复包过大/,
  );
});
