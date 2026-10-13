import crypto from 'node:crypto';

const PROTOCOL = 1;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TEXT = 256;

export type RecoveryTarget = {
  groupId: string;
  hostGeneration: number;
  hostDeviceId: string;
  publicKey: string;
  port: number;
};

export type RecoveryConfiguration = {
  publicUrl: string;
  accountId: string;
  tunnelId: string;
  zoneId: string;
  dnsRecordId: string | null;
};

export type RecoveryPackageMetadata = {
  protocol: typeof PROTOCOL;
  targetGroupId: string;
  targetHostGeneration: number;
  targetHostDeviceId: string;
  targetPublicKeySha256: string;
  targetPort: number;
  publicUrl: string;
  tunnelId: string;
  createdAt: number;
  expiresAt: number;
};

export type PublicRecoveryPackage = RecoveryPackageMetadata & {
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

export type RecoveredPublicConfiguration = RecoveryConfiguration & {
  token: string;
  metadata: RecoveryPackageMetadata;
};

const fail = (message: string): never => {
  throw new Error(message);
};

const text = (value: unknown, name: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT
  )
    fail(`恢复包${name}无效。`);
  return value as string;
};

const base64 = (value: string, name: string): Buffer => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1)
    fail(`恢复包${name}无效。`);
  const result = Buffer.from(value, 'base64');
  if (result.length === 0) fail(`恢复包${name}无效。`);
  return result;
};

const hex = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    fail(`恢复包${name}无效。`);
  return value as string;
};

const publicOrigin = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > MAX_TEXT)
    fail('公网入口无效。');
  const url = (() => {
    try {
      return new URL(value as string);
    } catch {
      return fail('公网入口无效。');
    }
  })();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    fail('公网入口必须是无凭据的 HTTPS origin。');
  return url.origin;
};

const exactObject = (value: unknown, keys: readonly string[], name: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${name}无效。`);
  const actual = Object.keys(value as object).sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== [...keys].sort()[index])
  )
    fail(`${name}字段无效。`);
  return value as Record<string, unknown>;
};

const decodeToken = (
  value: string,
  configuration: RecoveryConfiguration,
): Buffer => {
  if (value.length > MAX_TOKEN_BYTES * 2) fail('通道凭据过大。');
  const encoded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = base64(encoded, '通道凭据');
  if (raw.length > MAX_TOKEN_BYTES) fail('通道凭据过大。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('通道凭据格式无效。');
  }
  const object = exactObject(parsed, ['a', 't', 's'], '通道凭据');
  if (
    text(object.a, '通道账号') !== configuration.accountId ||
    text(object.t, '通道标识') !== configuration.tunnelId ||
    text(object.s, '通道密钥').length === 0
  )
    fail('通道凭据与公网配置不一致。');
  return raw;
};

const configuration = (value: unknown): RecoveryConfiguration => {
  const object = exactObject(
    value,
    ['accountId', 'dnsRecordId', 'publicUrl', 'tunnelId', 'zoneId'],
    '公网配置',
  );
  return {
    publicUrl: publicOrigin(object.publicUrl),
    accountId: text(object.accountId, '账号标识'),
    tunnelId: text(object.tunnelId, '通道标识'),
    zoneId: text(object.zoneId, '区域标识'),
    dnsRecordId:
      object.dnsRecordId === null
        ? null
        : text(object.dnsRecordId, 'DNS 记录标识'),
  };
};

const targetPublicKey = (
  target: RecoveryTarget,
): { der: Buffer; hash: string } => {
  const der = base64(target.publicKey, '目标公钥');
  let key!: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('目标公钥无效。');
  }
  if (
    key.asymmetricKeyType !== 'rsa' ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    fail('目标公钥强度不足。');
  return {
    der: key.export({ format: 'der', type: 'spki' }) as Buffer,
    hash: crypto
      .createHash('sha256')
      .update(key.export({ format: 'der', type: 'spki' }) as Buffer)
      .digest('hex'),
  };
};

const metadata = (
  value: unknown,
  now = Date.now(),
): RecoveryPackageMetadata => {
  const object = exactObject(
    value,
    [
      'createdAt',
      'expiresAt',
      'protocol',
      'publicUrl',
      'targetGroupId',
      'targetHostDeviceId',
      'targetHostGeneration',
      'targetPort',
      'targetPublicKeySha256',
      'tunnelId',
    ],
    '恢复包元数据',
  );
  if (
    object.protocol !== PROTOCOL ||
    !Number.isSafeInteger(object.targetHostGeneration) ||
    (object.targetHostGeneration as number) < 1 ||
    !Number.isSafeInteger(object.targetPort) ||
    (object.targetPort as number) < 1 ||
    (object.targetPort as number) > 65535 ||
    !Number.isSafeInteger(object.createdAt) ||
    !Number.isSafeInteger(object.expiresAt)
  )
    fail('恢复包元数据无效。');
  const createdAt = object.createdAt as number;
  const expiresAt = object.expiresAt as number;
  if (
    createdAt > now + CLOCK_SKEW_MS ||
    expiresAt <= now ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > MAX_LIFETIME_MS
  )
    fail('恢复包时间无效或已过期。');
  return {
    protocol: PROTOCOL,
    targetGroupId: text(object.targetGroupId, '目标设备组'),
    targetHostGeneration: object.targetHostGeneration as number,
    targetHostDeviceId: text(object.targetHostDeviceId, '目标主机'),
    targetPublicKeySha256: hex(object.targetPublicKeySha256, '目标公钥指纹'),
    targetPort: object.targetPort as number,
    publicUrl: publicOrigin(object.publicUrl),
    tunnelId: text(object.tunnelId, '通道标识'),
    createdAt,
    expiresAt,
  };
};

const aad = (value: RecoveryPackageMetadata): Buffer =>
  Buffer.from(JSON.stringify(value), 'utf8');

export function createPublicRecoveryPackage(
  target: RecoveryTarget,
  source: RecoveryConfiguration & { token: string },
  now = Date.now(),
): string {
  const publicKey = targetPublicKey(target);
  const config = configuration({
    publicUrl: source.publicUrl,
    accountId: source.accountId,
    tunnelId: source.tunnelId,
    zoneId: source.zoneId,
    dnsRecordId: source.dnsRecordId,
  });
  const token = decodeToken(source.token, config);
  const createdAt = now;
  const expiresAt = now + MAX_LIFETIME_MS;
  const meta: RecoveryPackageMetadata = {
    protocol: PROTOCOL,
    targetGroupId: text(target.groupId, '目标设备组'),
    targetHostGeneration: target.hostGeneration,
    targetHostDeviceId: text(target.hostDeviceId, '目标主机'),
    targetPublicKeySha256: publicKey.hash,
    targetPort: target.port,
    publicUrl: config.publicUrl,
    tunnelId: config.tunnelId,
    createdAt,
    expiresAt,
  };
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const plaintext = Buffer.from(
    JSON.stringify({ configuration: config, token: source.token }),
    'utf8',
  );
  const encrypted = crypto.createCipheriv('aes-256-gcm', key, nonce);
  encrypted.setAAD(aad(meta));
  const ciphertext = Buffer.concat([
    encrypted.update(plaintext),
    encrypted.final(),
  ]);
  const result: PublicRecoveryPackage = {
    ...meta,
    wrappedKey: crypto
      .publicEncrypt(
        {
          key: crypto.createPublicKey({
            key: publicKey.der,
            format: 'der',
            type: 'spki',
          }),
          oaepHash: 'sha256',
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        },
        key,
      )
      .toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: encrypted.getAuthTag().toString('base64'),
  };
  plaintext.fill(0);
  key.fill(0);
  token.fill(0);
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PACKAGE_BYTES)
    fail('恢复包过大。');
  return serialized;
}

export function openPublicRecoveryPackage(
  serialized: string,
  target: Omit<RecoveryTarget, 'publicKey'> & { privateKey: string },
  now = Date.now(),
): RecoveredPublicConfiguration {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PACKAGE_BYTES)
    fail('恢复包过大。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail('恢复包格式无效。');
  }
  const object = exactObject(
    parsed,
    [
      'ciphertext',
      'createdAt',
      'expiresAt',
      'protocol',
      'publicUrl',
      'nonce',
      'tag',
      'targetGroupId',
      'targetHostDeviceId',
      'targetHostGeneration',
      'targetPort',
      'targetPublicKeySha256',
      'tunnelId',
      'wrappedKey',
    ],
    '恢复包',
  );
  const meta = metadata(
    Object.fromEntries(
      [
        'protocol',
        'targetGroupId',
        'targetHostGeneration',
        'targetHostDeviceId',
        'targetPublicKeySha256',
        'targetPort',
        'publicUrl',
        'tunnelId',
        'createdAt',
        'expiresAt',
      ].map((key) => [key, object[key]]),
    ),
    now,
  );
  if (
    meta.targetGroupId !== text(target.groupId, '目标设备组') ||
    meta.targetHostGeneration !== target.hostGeneration ||
    meta.targetHostDeviceId !== text(target.hostDeviceId, '目标主机') ||
    meta.targetPort !== target.port
  )
    fail('恢复包目标不匹配。');
  let privateKey!: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({
      key: base64(target.privateKey, '目标私钥'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    fail('目标私钥无效。');
  }
  if (
    privateKey.asymmetricKeyType !== 'rsa' ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    fail('目标私钥强度不足。');
  const derived = crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' }) as Buffer;
  if (
    crypto.createHash('sha256').update(derived).digest('hex') !==
    meta.targetPublicKeySha256
  )
    fail('恢复包目标公钥不匹配。');
  const wrapped = base64(object.wrappedKey as string, '密钥封装');
  const nonce = base64(object.nonce as string, '随机数');
  const tag = base64(object.tag as string, '认证标签');
  const ciphertext = base64(object.ciphertext as string, '密文');
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    ciphertext.length > MAX_TOKEN_BYTES * 2
  )
    fail('恢复包密文无效。');
  let key!: Buffer;
  try {
    key = crypto.privateDecrypt(
      {
        key: privateKey,
        oaepHash: 'sha256',
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      wrapped,
    );
  } catch {
    fail('恢复包密钥解封失败。');
  }
  if (key.length !== 32) fail('恢复包密钥无效。');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad(meta));
  decipher.setAuthTag(tag);
  let plain!: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail('恢复包认证失败。');
  }
  if (plain.length > MAX_TOKEN_BYTES * 2) fail('恢复包明文过大。');
  try {
    const payload = JSON.parse(plain.toString('utf8')) as {
      configuration?: unknown;
      token?: unknown;
    };
    const config = configuration(payload.configuration);
    if (
      config.publicUrl !== meta.publicUrl ||
      config.tunnelId !== meta.tunnelId
    )
      fail('恢复包配置不一致。');
    const recoveredToken =
      typeof payload.token === 'string'
        ? payload.token
        : fail('恢复包凭据无效。');
    decodeToken(recoveredToken, config);
    return { ...config, token: recoveredToken, metadata: meta };
  } finally {
    plain.fill(0);
    key.fill(0);
  }
}
