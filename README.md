# Linchuan

Linchuan is a self-hosted browser workspace for computers and phones, on a home network or through an optional HTTPS Cloudflare Tunnel. It provides device presence, public and private chat, streamed file transfer, image previews, and video playback. A Windows host runs the service; other devices only open its URL.

[简体中文](README.zh-CN.md) · [Windows downloads](https://github.com/rotcst/linchuan/releases) · [Security](SECURITY.md) · [Design system](design/设计说明.md)

## Quick start

1. On one Windows 10/11 x64 computer, download **Linchuan.exe** from Releases and double-click it. No terminal or separate Node.js installation is required.
2. The launcher prepares bundled files under `%LOCALAPPDATA%\Linchuan\app`, keeps data separately under `%LOCALAPPDATA%\Linchuan\data`, and opens the host page. It runs silently until you choose **Stop background service** on that page. Closing the browser does not stop it. Opening the EXE again reuses the running service.
3. On another computer or phone, scan the QR code or use the host's LAN URL such as `http://192.168.x.x:3939`; enter the six-digit code shown on the host page. A webpage alone cannot start a stopped host.
4. If Windows Firewall blocks the LAN connection, run `%LOCALAPPDATA%\Linchuan\app\允许局域网访问.cmd` and approve the administrator prompt. This permits only the local subnet on TCP 3939.

The EXE extracts managed files; it is not an installer or an in-memory executable. Data is preserved across launches and application updates. Its default mode serves the LAN; an already configured tunnel starts automatically. The join code is available only on the localhost host page. Windows may show an unsigned-app warning; compare the download with the published SHA-256 checksum.

## Internet mode

Internet mode is optional and uses a Cloudflare Tunnel. The setup window asks for a masked DNS edit token, your own hostname, the Cloudflare Zone ID, and an optional Wrangler path. It does not require or reference another project checkout. Existing `data/cloudflare.json` metadata is used as the initial form value.

1. Obtain Wrangler through the official Cloudflare documentation, sign in with `wrangler login`, and verify the account with `wrangler whoami`.
2. For the EXE, run `%LOCALAPPDATA%\Linchuan\app\scripts\配置固定域名.cmd`. Enter a dedicated subdomain and Zone ID, and check the exact DNS record shown by the window.
3. Stop the service from its host page, then double-click **Linchuan.exe** again. For the folder package, use `启动互联网模式.vbs` after configuring that package.

The package includes a pinned Cloudflare runtime binary. Source builds use `node scripts/fetch-runtime.mjs` to download the official release and verify its pinned SHA-256.

## Data and privacy

Under the data directory, chat, device, and file indexes are stored in `linchuan.sqlite`; file bodies are in `uploads` and generated previews are in `previews`. Source/folder launches use the project/package's `data`; the EXE uses the separate AppData location above. Data is persistent by default and is not disk-encrypted. A device can hide its own messages without deleting the original file or another device's history. Stop the service before backing up the complete data directory. The tunnel credential is protected by the current Windows user and must be configured again when moving to another user or computer. Never publish the data directory.

LAN traffic uses HTTP. Internet mode uses HTTPS at the configured hostname. The application does not provide end-to-end encryption. A six-digit join code and rate limiting are convenience controls, not a substitute for trusted users, firewall rules, or HTTPS.

## Troubleshooting

- If another device cannot connect, confirm both devices are on the same non-guest Wi-Fi and that AP isolation is disabled.
- Run `允许局域网访问.cmd` as administrator to create the Windows Firewall rule for TCP 3939 and the local subnet.
- If a VPN or virtual adapter is present, choose the LAN address associated with the home router.
- Internet status is shown in the host page. The host must remain running, online, and awake for other devices to connect.

## Development and checks

```powershell
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm audit --audit-level=moderate
npm run build
npx playwright install chromium
npm run test:browser
npx tsx scripts/language-check.ts
npx tsx scripts/visual-check.ts
node scripts/fetch-runtime.mjs
npm run package
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-launcher.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-launcher.ps1
```

Browser tests use isolated temporary data directories. Install Playwright Chromium with `npx playwright install chromium` when needed. Useful environment variables are `PORT`, `JOIN_CODE`, `DATA_DIR`, and `INTERNET=1` for an already configured tunnel.

For source development, install Node.js 24.14.1 or newer and run `npm ci`; use `npm start` after building. For hot reload, run `npm run server:dev` and `npm run dev` separately.

The interface supports **Simplified Chinese, English, Korean, and Japanese**, with round flag icons and native language names in the menu. The initial language follows the browser, and an explicit selection is remembered. Chat text and user-defined device names are never translated. Light, charcoal dark, and system themes share the same design tokens. The gallery loads on demand.

There is no artificial file-type or single-file size limit. Files use streamed 8 MiB chunks; available disk, network, and browser capabilities still apply. Supported image previews are PNG, JPEG, GIF, WebP, and AVIF. MP4, MOV, and WebM can be played when the browser supports their codecs. Mobile media cards have one **Save** action, with native share or original-file download fallback. A webpage cannot silently write to a phone's photo library. Original files remain available through the normal access-control checks.
