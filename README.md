# Linchuan

Linchuan connects computers and phones over a home network or an optional HTTPS Cloudflare Tunnel. Windows uses a native C# WPF app; phones use the web interface. Both share device presence, public and private chat, persistent files, and media previews. The Windows app contains no WebView or embedded browser.

[简体中文](README.zh-CN.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [Windows downloads](https://github.com/rotcst/linchuan/releases) · [Security](SECURITY.md) · [Design system](design/设计说明.md)

## Quick start

1. On one Windows 10/11 x64 computer, download **Linchuan.exe** from Releases and double-click it. No terminal or separate Node.js installation is required.
2. The app prepares bundled files under `%LOCALAPPDATA%\Linchuan\app`, keeps service data under `%LOCALAPPDATA%\Linchuan\data`, and opens a native chat window. Closing the window hides it to the tray and keeps connections alive. Choose **Quit Linchuan** to stop a service started by this instance. Double-clicking again activates the existing window.
3. On another Windows computer, run the same EXE and enter the first computer's address and connection code in the initial connection dialog. Use **Device settings → Switch host computer** to change the target later. On a phone, scan the QR code in the right connection panel or open the LAN/HTTPS URL and enter the code. A webpage alone cannot start a stopped host.
4. If Windows Firewall blocks the LAN connection, run `%LOCALAPPDATA%\Linchuan\app\允许局域网访问.cmd` and approve the administrator prompt. This permits only the local subnet on TCP 3939.

The self-contained x64 EXE includes the .NET runtime, Node.js backend, and Cloudflare runtime. It extracts managed files on first launch and preserves service data across updates. Its default mode serves the LAN; an already configured tunnel starts automatically. Native session tokens are protected with Windows DPAPI for the current user under `%LOCALAPPDATA%\Linchuan\desktop`. Windows may show an unsigned-app warning; compare the download with the published SHA-256 checksum.

## Version and updates

The main window and system tray menu display the installed version and provide **Check for updates**. A manual check queries this repository's latest stable GitHub Release. When an update is available, open its official release page to download the single EXE. Network errors are reported separately from an up-to-date result. Checks do not upload chat, files, or tunnel credentials.

Verify the release checksum, choose **Quit Linchuan**, then run the new EXE. Existing `data` and `desktop` directories are preserved. Checking does not automatically install, execute downloaded files, or restart the service.

## Internet mode

Internet mode is optional and uses a Cloudflare Tunnel. The setup window asks for a masked DNS edit token, your own hostname, the Cloudflare Zone ID, and an optional Wrangler path. It does not require or reference another project checkout. Existing `data/cloudflare.json` metadata is used as the initial form value.

1. Obtain Wrangler through the official Cloudflare documentation, sign in with `wrangler login`, and verify the account with `wrangler whoami`.
2. For the EXE, run `%LOCALAPPDATA%\Linchuan\app\scripts\配置固定域名.cmd`. Enter a dedicated subdomain and Zone ID, and check the exact DNS record shown by the window.
3. Choose **Quit Linchuan**, then double-click **Linchuan.exe** again. The native app starts an already configured tunnel automatically. `--local` forces LAN-only mode.

The package includes a pinned Cloudflare runtime binary. Source builds use `node scripts/fetch-runtime.mjs` to download the official release and verify its pinned SHA-256.

## Data and privacy

Under the data directory, chat, device, and file indexes are stored in `linchuan.sqlite`; file bodies are in `uploads` and generated previews are in `previews`. Source/folder launches use the project/package's `data`; the EXE uses the separate AppData location above. Data is persistent by default and is not disk-encrypted. A device can hide its own messages without deleting the original file or another device's history. Stop the service before backing up the complete data directory. The tunnel credential is protected by the current Windows user and must be configured again when moving to another user or computer. Never publish the data directory.

LAN traffic uses HTTP. Internet mode uses HTTPS at the configured hostname. The application does not provide end-to-end encryption. A six-digit join code and rate limiting are convenience controls, not a substitute for trusted users, firewall rules, or HTTPS.

## Troubleshooting

- If another device cannot connect, confirm both devices are on the same non-guest Wi-Fi and that AP isolation is disabled.
- Run `允许局域网访问.cmd` as administrator to create the Windows Firewall rule for TCP 3939 and the local subnet.
- If a VPN or virtual adapter is present, choose the LAN address associated with the home router.
- Internet status is shown in the native host window. The host must remain running, online, and awake for other devices to connect.
- The connection menu includes `http://127.0.0.1:3939`, detected LAN URLs, and the saved HTTPS hostname. Loopback works only on the host itself. A listed hostname does not prove the tunnel is connected; check its status too.
- Source/folder launches and the single EXE use different data directories. When migrating the previous web host, keep `cloudflare.json` and `tunnel-token.dpapi` together under the actual EXE data directory, for the same Windows user. Packaged development tools may redirect AppData file access. Run the app/setup from File Explorer and verify the actual location. Do not overwrite an existing chat database.
- Cloudflare error 1033 means no healthy tunnel connector is available. If the page loads but a native client gets HTTP 403 or a browser challenge, inspect browser-only challenge rules for the dedicated hostname's `/api/` and `/ws`. Native requests declare a normal `Linchuan/<version>` User-Agent, allowing empty-User-Agent rules to remain enabled. Native clients cannot complete JavaScript challenges. Scope any adjustment to the service hostname and endpoints while retaining application authentication, rate limits, and other sites' protections.

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
dotnet build native/Linchuan.Desktop/Linchuan.Desktop.csproj -c Release
dotnet run --project native/Linchuan.Desktop.Tests -c Release
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-desktop.ps1
```

Building the native app requires the .NET 10 SDK on Windows; end users need no separate runtime installation. Browser and native tests use isolated temporary data. The native harness exercises actual WPF controls, WebSocket presence, privacy, multi-chunk SHA-256 transfer, gallery, four languages and both themes, and writes screenshots under `qa/native`.

For source development, install Node.js 24.14.1 or newer and run `npm ci`; use `npm start` after building. For hot reload, run `npm run server:dev` and `npm run dev` separately.

Both interfaces support **Simplified Chinese, English, Korean, and Japanese**, round flags, and light, charcoal dark, and system themes. WPF consumes the same `src/tokens.css` and language catalogs as the phone web interface. Chat text and user-defined device names are never translated. A local Windows user can explicitly select a previous computer identity during joining to retain its private history and hidden messages. This identity import API rejects remote and browser-origin requests.

There is no artificial file-type or single-file size limit. Files use streamed 8 MiB chunks, with at most 20 files selected at once and a 256 MiB free-disk reserve on the server; disk, network, and platform capabilities still apply. Native downloads replace their destination only after success. Native image previews use generated PNGs; the original file remains unchanged and downloadable. Wheel zoom, drag, arrow navigation, copy, and per-device deletion are provided in WPF. Native videos are downloaded to a temporary cache before playback and depend on Windows codecs. Unsupported media remain downloadable. Phone media cards have one **Save** action, with system share or original-file download fallback; webpages cannot silently write to a phone's photo library.
