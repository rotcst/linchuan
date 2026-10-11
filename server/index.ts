import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createLanServer } from './app.js';

const dataDir = process.env.DATA_DIR ?? path.resolve('data');
const internet = process.env.INTERNET === '1';
let publicUrl = process.env.PUBLIC_URL;
if (internet) {
  const configuration = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'cloudflare.json'), 'utf8'),
  ) as { publicUrl: string };
  publicUrl = configuration.publicUrl;
}
let tunnel: ChildProcess | null = null;
let restartTimer: ReturnType<typeof setTimeout>;
let shuttingDown = false;
let internetStatus = internet ? 'connecting' : 'disabled';
const lan = createLanServer({
  port: Number(process.env.PORT ?? 3939),
  host: '0.0.0.0',
  dataDir,
  publicDir: path.resolve('dist'),
  publicUrl,
  hostStatus: () => ({ internet: internetStatus }),
  onStop: () => stop(),
});
void lan
  .start()
  .then(() => {
    const actualPort = lan.getPort() ?? Number(process.env.PORT ?? 3939);
    const urls = lan.getUrls();
    console.log('邻传已启动');
    console.log(`本机访问: http://127.0.0.1:${actualPort}`);
    console.log(
      `局域网访问: ${urls.length ? urls.join('、') : '未检测到局域网地址'}`,
    );
    console.log('连接码显示在本机网页中。文件和聊天记录持久保存。');
    if (internet) {
      const executable = path.resolve('runtime/cloudflared.exe');
      let tunnelToken: string;
      try {
        tunnelToken = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.resolve('scripts/读取通道凭据.ps1'),
            '-Path',
            path.join(dataDir, 'tunnel-token.dpapi'),
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ).trim();
      } catch {
        internetStatus = 'error';
        console.error('无法读取本机加密的通道凭据，请重新运行配置固定域名。');
        return;
      }
      if (!fs.existsSync(executable) || !tunnelToken) {
        internetStatus = 'error';
        console.error('互联网运行时或通道凭据缺失。局域网仍可使用。');
        return;
      }
      console.log(`互联网入口: ${publicUrl}`);
      const startTunnel = () => {
        if (shuttingDown) return;
        internetStatus = 'connecting';
        tunnel = spawn(
          executable,
          ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'],
          {
            windowsHide: true,
            env: { ...process.env, TUNNEL_TOKEN: tunnelToken },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let registered = false;
        const output = (buffer: Buffer) => {
          const text = buffer.toString('utf8');
          if (!registered && text.includes('Registered tunnel connection')) {
            registered = true;
            internetStatus = 'connected';
            console.log(`HTTPS 通道已连接: ${publicUrl}`);
          }
          if (
            /Unauthorized|Invalid tunnel|failed to authenticate/i.test(text)
          ) {
            internetStatus = 'error';
            console.error('互联网通道授权失败，请重新配置。');
          }
        };
        tunnel.stdout?.on('data', output);
        tunnel.stderr?.on('data', output);
        tunnel.on('error', () =>
          console.error('无法启动互联网通道，局域网仍可使用。'),
        );
        tunnel.on('exit', () => {
          internetStatus = 'reconnecting';
          if (!shuttingDown) {
            console.log('互联网通道已停止，10 秒后重试。');
            restartTimer = setTimeout(startTunnel, 10000);
          }
        });
      };
      startTunnel();
    }
    if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32')
      spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${actualPort}`], {
        windowsHide: true,
        detached: true,
      }).unref();
  })
  .catch((error) => {
    console.error(
      '邻传启动失败:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
const stop = () => {
  shuttingDown = true;
  clearTimeout(restartTimer);
  tunnel?.kill();
  void lan.close().finally(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
