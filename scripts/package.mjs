import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

const root = process.cwd();
const destination = path.join(root, 'release', '邻传-Windows免安装版');
const assertManagedTarget = async (target) => {
  const absolute = path.resolve(target);
  const releaseRoot = path.join(root, 'release');
  if (!absolute.startsWith(`${releaseRoot}${path.sep}`))
    throw new Error('Package target must remain inside the release directory.');
  let current = absolute;
  while (current !== root) {
    const stat = await fs.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error(
        `Refusing a package path with a reparse point: ${current}`,
      );
    current = path.dirname(current);
  }
};
await assertManagedTarget(destination);
await fs.mkdir(destination, { recursive: true });
// Only clean folders and files owned by this package. In particular, preserve
// runtime data, credentials, and any user-created files under release.
for (const name of ['dist', 'build', 'scripts']) {
  await assertManagedTarget(path.join(destination, name));
  await fs.rm(path.join(destination, name), { recursive: true, force: true });
}
const runtimeDestination = path.join(destination, 'runtime');
await assertManagedTarget(runtimeDestination);
try {
  for (const entry of await fs.readdir(runtimeDestination)) {
    if (entry !== 'node.exe') {
      await assertManagedTarget(path.join(runtimeDestination, entry));
      await fs.rm(path.join(runtimeDestination, entry), {
        recursive: true,
        force: true,
      });
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// node_modules is fully owned by the package. Rebuild it on every package
// run so a previous release cannot omit package metadata required by Node's
// package exports (for example @img/sharp-win32-x64/package.json).
const nodeModulesDestination = path.join(destination, 'node_modules');
await assertManagedTarget(nodeModulesDestination);
await fs.rm(nodeModulesDestination, { recursive: true, force: true });
for (const name of [
  '启动邻传.cmd',
  '启动邻传.ps1',
  '启动邻传.vbs',
  '启动互联网模式.cmd',
  '启动互联网模式.vbs',
  '允许局域网访问.cmd',
  'README.md',
  'README.zh-CN.md',
  'README.ko.md',
  'README.ja.md',
  'SECURITY.md',
  'THIRD-PARTY-LICENSES.txt',
  'manifest.json',
]) {
  await assertManagedTarget(path.join(destination, name));
  await fs.rm(path.join(destination, name), { force: true });
}
for (const name of ['dist', 'build', 'scripts'])
  await fs.mkdir(path.join(destination, name), { recursive: true });
await fs.cp(path.join(root, 'dist'), path.join(destination, 'dist'), {
  recursive: true,
});
for (const name of ['server.cjs', 'server.cjs.LEGAL.txt']) {
  const source = path.join(root, 'build', name);
  try {
    await fs.copyFile(source, path.join(destination, 'build', name));
  } catch (error) {
    if (name === 'server.cjs') throw error;
  }
}
for (const name of [
  '允许局域网访问.cmd',
  'README.md',
  'README.zh-CN.md',
  'README.ko.md',
  'README.ja.md',
  'SECURITY.md',
  'LICENSE',
])
  await fs.copyFile(path.join(root, name), path.join(destination, name));
for (const name of [
  '允许局域网访问.ps1',
  '配置固定域名.ps1',
  '配置固定域名.cmd',
  '读取通道凭据.ps1',
])
  await fs.copyFile(
    path.join(root, 'scripts', name),
    path.join(destination, 'scripts', name),
  );
await fs.mkdir(runtimeDestination, { recursive: true });
const packagedNode = path.join(runtimeDestination, 'node.exe');
let nodeIsCurrent = false;
try {
  const [sourceHash, packagedHash] = await Promise.all([
    crypto
      .createHash('sha256')
      .update(await fs.readFile(process.execPath))
      .digest('hex'),
    crypto
      .createHash('sha256')
      .update(await fs.readFile(packagedNode))
      .digest('hex'),
  ]);
  nodeIsCurrent = sourceHash === packagedHash;
} catch {
  // The destination file may not exist yet.
}
if (!nodeIsCurrent) await fs.copyFile(process.execPath, packagedNode);
await fs.copyFile(
  path.join(root, 'runtime', 'cloudflared.exe'),
  path.join(destination, 'runtime', 'cloudflared.exe'),
);
await fs.copyFile(
  path.join(root, 'licenses', 'CLOUDFLARED-LICENSE.txt'),
  path.join(destination, 'runtime', 'CLOUDFLARED-LICENSE.txt'),
);
const licenses = [];
const modules = path.join(root, 'node_modules');
// Sharp uses a native addon; ship its installed runtime dependency graph.
const copiedRuntime = new Set();
const copyRuntimePackage = async (name) => {
  if (copiedRuntime.has(name)) return;
  const source = path.join(modules, name);
  const target = path.join(destination, 'node_modules', name);
  await assertManagedTarget(target);
  let metadata;
  try {
    metadata = JSON.parse(
      await fs.readFile(path.join(source, 'package.json'), 'utf8'),
    );
  } catch {
    return;
  }
  copiedRuntime.add(name);
  const targetExists = await fs
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!targetExists) {
    await fs.cp(source, target, { recursive: true });
  }
  for (const dependency of Object.keys({
    ...metadata.dependencies,
    ...metadata.optionalDependencies,
  }))
    await copyRuntimePackage(dependency);
};
await copyRuntimePackage('sharp');
const collect = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      await collect(dir);
      continue;
    }
    let metadata;
    try {
      metadata = JSON.parse(
        await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    const licenseFiles = (await fs.readdir(dir)).filter((name) =>
      /^(licen[cs]e|copying|notice)(\.|$)/i.test(name),
    );
    for (const name of licenseFiles) {
      if (!(await fs.stat(path.join(dir, name))).isFile()) continue;
      licenses.push(
        `\n--- ${metadata.name} ${metadata.version}: ${name} ---\n${await fs.readFile(path.join(dir, name), 'utf8')}`,
      );
    }
  }
};
await collect(modules);
await fs.writeFile(
  path.join(destination, 'THIRD-PARTY-LICENSES.txt'),
  licenses.join('\n'),
);
const nodeLicense = path.join(root, 'licenses', 'NODE-LICENSE.txt');
await fs.copyFile(
  nodeLicense,
  path.join(destination, 'runtime', 'NODE-LICENSE.txt'),
);
const manifest = {
  product: '邻传',
  version: JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  ).version,
  node: process.version,
  builtAt: new Date().toISOString(),
  files: {},
};
const packageDirectories = [
  'dist',
  'build',
  'scripts',
  'runtime',
  'node_modules',
];
const packageFiles = [
  '允许局域网访问.cmd',
  'README.md',
  'README.zh-CN.md',
  'README.ko.md',
  'README.ja.md',
  'SECURITY.md',
  'LICENSE',
  'THIRD-PARTY-LICENSES.txt',
];
const hashFiles = async (directory) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await hashFiles(file);
    else {
      const relative = path.relative(destination, file).replaceAll('\\', '/');
      if (relative === 'manifest.json') continue;
      manifest.files[relative] = crypto
        .createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
    }
  }
};
for (const name of packageDirectories)
  await hashFiles(path.join(destination, name));
for (const name of packageFiles) {
  const file = path.join(destination, name);
  manifest.files[name] = crypto
    .createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}
await fs.writeFile(
  path.join(destination, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(`Windows 免安装版已生成：${destination}`);
