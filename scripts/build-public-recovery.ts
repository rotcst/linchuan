import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const MAX_PACKAGE_BYTES = 64 * 1024;
const scriptFile = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(scriptFile);

function assertSafePath(value: string) {
  if (value.startsWith('\\\\') || value.startsWith('//'))
    throw new Error('恢复工具不支持网络路径。');
  let current = path.resolve(value);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error('恢复目录不能包含链接。');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertRegularFile(value: string) {
  assertSafePath(value);
  const stat = fs.statSync(value);
  if (!stat.isFile()) throw new Error('恢复输入必须是普通文件。');
}

function sha256(value: Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertRecoveryPackage(bytes: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('恢复输入不是有效恢复包。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('恢复输入不是有效恢复包。');
  const object = value as Record<string, unknown>;
  const keys = [
    'ciphertext',
    'createdAt',
    'expiresAt',
    'nonce',
    'protocol',
    'publicUrl',
    'tag',
    'targetGroupId',
    'targetHostDeviceId',
    'targetHostGeneration',
    'targetPort',
    'targetPublicKeySha256',
    'tunnelId',
    'wrappedKey',
  ].sort();
  if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify(keys))
    throw new Error('恢复输入不是有效恢复包。');
  if (object.protocol !== 1 || typeof object.publicUrl !== 'string')
    throw new Error('恢复输入不是有效恢复包。');
  let url: URL;
  try {
    url = new URL(object.publicUrl);
  } catch {
    throw new Error('恢复输入不是有效恢复包。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('恢复输入不是有效恢复包。');
  for (const key of [
    'targetGroupId',
    'targetHostDeviceId',
    'targetPublicKeySha256',
    'tunnelId',
    'wrappedKey',
    'nonce',
    'ciphertext',
    'tag',
  ]) {
    if (typeof object[key] !== 'string' || object[key] === '')
      throw new Error('恢复输入不是有效恢复包。');
  }
  if (
    !Number.isSafeInteger(object.targetHostGeneration) ||
    (object.targetHostGeneration as number) < 1 ||
    !Number.isSafeInteger(object.targetPort) ||
    (object.targetPort as number) < 1 ||
    (object.targetPort as number) > 65535 ||
    !Number.isSafeInteger(object.createdAt) ||
    !Number.isSafeInteger(object.expiresAt)
  )
    throw new Error('恢复输入不是有效恢复包。');
  if (!/^[a-f0-9]{64}$/.test(object.targetPublicKeySha256 as string))
    throw new Error('恢复输入不是有效恢复包。');
  for (const key of ['wrappedKey', 'nonce', 'ciphertext', 'tag']) {
    const encoded = object[key] as string;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1)
      throw new Error('恢复输入不是有效恢复包。');
    if (Buffer.from(encoded, 'base64').length === 0)
      throw new Error('恢复输入不是有效恢复包。');
  }
}

export type PublicRecoveryBuild = {
  outputDir: string;
  packageHash: string;
  programHash: string;
  nodeHash: string;
};

export async function buildPublicRecoveryDirectory(
  packagePath: string,
  bundledNodePath: string,
  outputDir: string,
): Promise<PublicRecoveryBuild> {
  for (const inputPath of [packagePath, bundledNodePath, outputDir])
    assertSafePath(inputPath);
  packagePath = path.resolve(packagePath);
  bundledNodePath = path.resolve(bundledNodePath);
  outputDir = path.resolve(outputDir);
  assertRegularFile(packagePath);
  assertRegularFile(bundledNodePath);
  if (fs.statSync(packagePath).size > MAX_PACKAGE_BYTES)
    throw new Error('恢复包过大。');
  assertSafePath(outputDir);
  if (fs.existsSync(outputDir)) throw new Error('恢复输出目录必须是全新的。');

  const packageBytes = await fsp.readFile(packagePath);
  const nodeBytes = await fsp.readFile(bundledNodePath);
  assertRecoveryPackage(packageBytes);
  const sourceCli = path.resolve(scriptRoot, 'public-recovery-cli.ts');
  const sourcePs = path.resolve(scriptRoot, '恢复公网.ps1');
  assertRegularFile(sourceCli);
  assertRegularFile(sourcePs);
  const packageHash = sha256(packageBytes);
  const nodeHash = sha256(nodeBytes);
  await fsp.mkdir(outputDir, { recursive: true });
  const generatedPaths = [
    path.join(outputDir, '恢复公网.cjs'),
    path.join(outputDir, '恢复公网.ps1'),
    path.join(outputDir, '公网恢复包.json'),
    path.join(outputDir, '恢复公网.cmd'),
  ];
  try {
    const programPath = path.join(outputDir, '恢复公网.cjs');
    const psPath = path.join(outputDir, '恢复公网.ps1');
    const packetPath = path.join(outputDir, '公网恢复包.json');
    const cmdPath = path.join(outputDir, '恢复公网.cmd');
    await build({
      entryPoints: [sourceCli],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: programPath,
      legalComments: 'none',
    });
    const programBytes = await fsp.readFile(programPath);
    const programHash = sha256(programBytes);
    const psText = await fsp.readFile(sourcePs, 'utf8');
    await fsp.writeFile(
      psPath,
      psText.startsWith('\ufeff') ? psText : `\ufeff${psText}`,
      'utf8',
    );
    await fsp.writeFile(packetPath, packageBytes);
    const cmd = [
      '@echo off',
      'setlocal EnableExtensions',
      'set "PS="',
      'for %%F in ("%~dp0*.ps1") do (',
      '  if defined PS exit /b 2',
      '  set "PS=%%~fF"',
      ')',
      'if not defined PS exit /b 2',
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS%" -ExpectedPackageHash ${packageHash} -ExpectedProgramHash ${programHash} -ExpectedNodeHash ${nodeHash}`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
    if ([...cmd].some((character) => character.charCodeAt(0) > 127))
      throw new Error('恢复启动器必须是 ASCII。');
    await fsp.writeFile(cmdPath, cmd, 'ascii');
    return { outputDir, packageHash, programHash, nodeHash };
  } catch (error) {
    assertSafePath(outputDir);
    for (const generatedPath of generatedPaths) {
      if (!fs.existsSync(generatedPath)) continue;
      assertSafePath(generatedPath);
      await fsp.rm(generatedPath, { force: true });
    }
    try {
      await fsp.rmdir(outputDir);
    } catch {
      // Preserve any unexpected file created concurrently in the fresh output.
    }
    throw error;
  } finally {
    packageBytes.fill(0);
    nodeBytes.fill(0);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(scriptFile)
) {
  const [, , packagePath, nodePath, outputDir] = process.argv;
  if (!packagePath || !nodePath || !outputDir)
    throw new Error(
      '用法：build-public-recovery <恢复包> <bundled node.exe> <全新输出目录>',
    );
  await buildPublicRecoveryDirectory(packagePath, nodePath, outputDir);
}
