import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { createPublicRecoveryPackage } from '../server/public-recovery.js';

test(
  'Windows recovery wrapper protects credentials and preserves existing data',
  { skip: process.platform !== 'win32' },
  async () => {
    fs.mkdirSync('qa', { recursive: true });
    const root = fs.mkdtempSync(path.resolve('qa/public-recovery-'));
    try {
      const home = path.join(root, 'Linchuan');
      const data = path.join(home, 'data');
      const desktop = path.join(home, 'desktop');
      const runtime = path.join(home, 'app/runtime');
      for (const directory of [data, desktop, runtime])
        fs.mkdirSync(directory, { recursive: true });
      const node = path.join(runtime, 'node.exe');
      fs.copyFileSync(process.execPath, node);
      const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const target = {
        groupId: crypto.randomUUID(),
        hostGeneration: 1,
        hostDeviceId: 'test-service-owner',
        port: 3939,
        publicKey: pair.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64'),
      };
      const source = {
        publicUrl: 'https://transfer.example.test',
        accountId: 'a'.repeat(32),
        zoneId: 'b'.repeat(32),
        dnsRecordId: 'c'.repeat(32),
        tunnelId: crypto.randomUUID(),
        token: '',
      };
      source.token = Buffer.from(
        JSON.stringify({
          a: source.accountId,
          t: source.tunnelId,
          s: crypto.randomBytes(32).toString('base64'),
        }),
      ).toString('base64');
      fs.writeFileSync(
        path.join(desktop, 'ui.json'),
        JSON.stringify({
          Hosting: true,
          HostDataDir: data,
          HostPort: 3939,
          DeviceId: target.hostDeviceId,
        }),
      );
      const database = path.join(data, 'linchuan.sqlite');
      const db = new DatabaseSync(database);
      db.exec(
        "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE preserved_chat(text TEXT); INSERT INTO preserved_chat VALUES ('keep real data')",
      );
      const write = db.prepare('INSERT INTO metadata VALUES (?,?)');
      for (const [key, value] of Object.entries({
        'network.groupId': target.groupId,
        'network.hostGeneration': '1',
        'network.publicKey': target.publicKey,
        'network.privateKey': pair.privateKey
          .export({ type: 'pkcs8', format: 'der' })
          .toString('base64'),
        'host.deviceId': target.hostDeviceId,
      }))
        write.run(key, value);
      db.close();
      const hash = (file: string) =>
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const before = hash(database);
      const oldConfiguration = JSON.stringify({
        publicUrl: 'https://old.example.test',
      });
      fs.writeFileSync(path.join(data, 'cloudflare.json'), oldConfiguration);
      fs.writeFileSync(
        path.join(data, 'tunnel-token.dpapi'),
        Buffer.from('old encrypted fixture'),
      );
      const packet = path.join(root, '公网恢复包.json');
      fs.writeFileSync(packet, createPublicRecoveryPackage(target, source));
      const program = path.join(root, '恢复公网.cjs');
      await build({
        entryPoints: ['scripts/public-recovery-cli.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: program,
      });
      const wrapper = path.join(root, 'recover-public.ps1');
      fs.writeFileSync(
        wrapper,
        '\ufeff' +
          fs
            .readFileSync('scripts/恢复公网.ps1', 'utf8')
            .replace(/^\ufeff/, ''),
      );
      const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        wrapper,
        '-NonInteractive',
        '-ExpectedPackageHash',
        hash(packet),
        '-ExpectedProgramHash',
        hash(program),
        '-ExpectedNodeHash',
        hash(node),
      ];
      const powershell = path.join(
        process.env.WINDIR!,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      const environment = { ...process.env, LOCALAPPDATA: root };
      // Failure of the optional receipt must not undo or misreport committed config.
      fs.mkdirSync(path.join(root, '恢复结果.txt'));
      execFileSync(powershell, args, {
        env: environment,
        timeout: 30000,
        windowsHide: true,
        stdio: 'pipe',
      });
      assert.equal(hash(database), before);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(data, 'cloudflare.json'), 'utf8')),
        Object.fromEntries(
          Object.entries(source).filter(([key]) => key !== 'token'),
        ),
      );
      assert.equal(
        fs
          .readdirSync(data)
          .some((name) => name.startsWith('public-recovery-backup-')),
        false,
      );
      const protectedToken = fs.readFileSync(
        path.join(data, 'tunnel-token.dpapi'),
      );
      assert.equal(protectedToken.includes(source.token), false);
      const tokenPath = path
        .join(data, 'tunnel-token.dpapi')
        .replaceAll("'", "''");
      const tokenHash = execFileSync(
        powershell,
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.Security; $b=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${tokenPath}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); $h=[Security.Cryptography.SHA256]::Create(); try { [BitConverter]::ToString($h.ComputeHash($b)).Replace('-','').ToLowerInvariant() } finally { [Array]::Clear($b,0,$b.Length);$h.Dispose() }`,
        ],
        {
          env: environment,
          encoding: 'utf8',
          timeout: 20000,
          windowsHide: true,
        },
      ).trim();
      assert.equal(
        tokenHash,
        crypto.createHash('sha256').update(source.token).digest('hex'),
      );
      const configHash = hash(path.join(data, 'cloudflare.json'));
      fs.chmodSync(path.join(data, 'cloudflare.json'), 0o444);
      try {
        assert.throws(() =>
          execFileSync(powershell, args, {
            env: environment,
            timeout: 30000,
            windowsHide: true,
            stdio: 'pipe',
          }),
        );
      } finally {
        fs.chmodSync(path.join(data, 'cloudflare.json'), 0o666);
      }
      assert.equal(hash(path.join(data, 'cloudflare.json')), configHash);
      assert.deepEqual(
        fs.readFileSync(path.join(data, 'tunnel-token.dpapi')),
        protectedToken,
      );
      assert.equal(hash(database), before);
      assert.equal(
        fs
          .readdirSync(data)
          .some((name) => name.startsWith('public-recovery-backup-')),
        false,
      );
      assert.throws(() =>
        execFileSync(
          node,
          [
            program,
            'decrypt',
            packet,
            data,
            target.hostDeviceId,
            '3939',
            hash(packet),
          ],
          {
            env: { ...environment, LINCHUAN_RECOVERY_PIPE: '' },
            stdio: 'pipe',
          },
        ),
      );
    } finally {
      const prefix = path.resolve('qa') + path.sep;
      assert.ok(path.resolve(root).startsWith(prefix));
      const powershell = path.join(
        process.env.WINDIR!,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      const literalRoot = root.replaceAll("'", "''");
      const literalPrefix = prefix.replaceAll("'", "''");
      execFileSync(
        powershell,
        [
          '-NoProfile',
          '-Command',
          `$ErrorActionPreference='Stop';$taskRoot=[IO.Path]::GetFullPath('${literalRoot}');if (!$taskRoot.StartsWith('${literalPrefix}',[StringComparison]::OrdinalIgnoreCase)) {throw 'Cleanup path out of scope'};$taskItems=@(Get-Item -LiteralPath $taskRoot -Force)+@(Get-ChildItem -LiteralPath $taskRoot -Recurse -Force);if ($taskItems | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}) {throw 'Refusing link cleanup'};Remove-Item -LiteralPath $taskRoot -Recurse -Force`,
        ],
        { windowsHide: true, timeout: 30000, stdio: 'pipe' },
      );
    }
  },
);
