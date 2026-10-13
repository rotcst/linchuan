# Linchuan

A maintainer can generate a recipient-bound offline package to restore lost public configuration on the current host; this is not a general recovery entry bundled with the EXE. It verifies the local group, owner, generation and port using a read-only database, then protects credentials with that Windows user's DPAPI. Chats and files remain unchanged. Packages expire within 24 hours; run `恢复公网.cmd` locally on the target, then quit from the tray and restart. Maintainers create ciphertext through the [recovery CLI](scripts/public-recovery-cli.ts) using private standard input, then use the [directory builder](scripts/build-public-recovery.ts) to generate a launcher with fixed integrity hashes. Do not publish credential packages to GitHub.

### Public entry preservation after transfer (1.2.1)

The public origin is persisted with the group snapshot. A complete transfer validates the origin and protected credential, then checks the destination group and generation before activation. Both PCs retain the public entry after transfer and the new host retains it after restart. Upgrade both Windows PCs. Preserve original data after a failed transfer and resume or retry the complete transfer; manually joining another service is not a completed migration. Upgrading cannot create Cloudflare credentials for an independent new group.

An incomplete recovery record left by 1.2.0 requires separate recovery. Unsigned records are rejected; preserve the original `data` and `desktop` directories.

Linchuan connects computers and phones over a home network or an optional HTTPS Cloudflare Tunnel. Windows uses a native C# WPF app; phones use the web interface. Both share device presence, public and private chat, persistent files, and media previews. The Windows app contains no WebView or embedded browser.

[简体中文](README.zh-CN.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [Windows downloads](https://github.com/rotcst/linchuan/releases) · [Security](SECURITY.md) · [Design system](design/设计说明.md)

## Quick start

1. On one Windows 10/11 x64 computer, download **Linchuan.exe** from Releases and double-click it. No terminal or separate Node.js installation is required.
2. The app prepares bundled files under `%LOCALAPPDATA%\Linchuan\app`, keeps service data under `%LOCALAPPDATA%\Linchuan\data`, and opens a native chat window. Closing the window hides it to the tray and keeps connections alive. Choose **Quit Linchuan** to stop a service started by this instance. Double-clicking again activates the existing window.
3. On another Windows computer, run the same EXE and enter the first computer's address and connection code in the initial connection dialog. Use **Device settings → Switch host computer** to change the target later. On a phone, scan the QR code in the right connection panel or open the LAN/HTTPS URL and enter the code. A webpage alone cannot start a stopped host.
4. If Windows Firewall blocks the LAN connection, run `%LOCALAPPDATA%\Linchuan\app\允许局域网访问.cmd` and approve the administrator prompt. This permits the bundled Node program from the local subnet on TCP 3939/3940 and UDP 3941–3972.

The self-contained x64 EXE includes the .NET runtime, Node.js backend, and Cloudflare runtime. It extracts managed files on first launch and preserves service data across updates. Its default mode serves the LAN; an already configured tunnel starts automatically. Native session tokens are protected with Windows DPAPI for the current user under `%LOCALAPPDATA%\Linchuan\desktop`. Windows may show an unsigned-app warning; compare the download with the published SHA-256 checksum.

## Version and updates

The main window and system tray menu display the installed version and provide **Check for updates**. A manual check queries this repository's latest stable GitHub Release. When an update is available, open its official release page to download the single EXE. Network errors are reported separately from an up-to-date result. Checks do not upload chat, files, or tunnel credentials.

Verify the release checksum, choose **Quit Linchuan**, then run the new EXE. Existing `data` and `desktop` directories are preserved. Checking does not automatically install, execute downloaded files, or restart the service.

## Internet mode

### Automatic routes and host transfer (1.2.0)

Pair each device once with the host's code or QR link. Windows then prefers the same group's authenticated TLS LAN connection. A phone opened through the group's HTTPS hostname uses an encrypted WebRTC LAN data channel when ICE can connect directly; outside the LAN it keeps using HTTPS/WSS. There is no STUN/TURN relay, automatic plaintext fallback, or browser security bypass. If the browser blocks direct connections, HTTPS continues to work. Returning home retries direct connection every 15 seconds. First opening a phone page still needs a reachable host for signaling.

When a LAN page has a working public tunnel, it transfers the phone identity to that HTTPS origin with a short-lived, single-use ticket. Keep using that hostname on the phone when going out; the service computer must stay awake and its tunnel must remain connected.

On the service PC, right-click an online Windows device and choose **Transfer service host**. Both PCs must be on the same LAN and run 1.2.0 or newer. The transfer freezes writes, snapshots chat and device identities, copies every committed file, verifies SHA-256, and stages the new host before committing. Tunnel credentials are encrypted for the target and protected again with its current user's DPAPI. The target becomes host; the old PC automatically becomes a client. Pending transfers resume from disk after restart; an uncommitted transfer can expire without activating its destination. The imported host data is kept in a generation-specific `data/groups` directory; the old host's fenced data is preserved.

When upgrading from 1.1.x, run `%LOCALAPPDATA%\Linchuan\app\允许局域网访问.cmd` again if LAN traffic is blocked. The helper permits only the bundled Node program and local subnet: TCP 3939/3940 and UDP 3941–3972. No router port forwarding is needed. Custom `--port` launches need matching HTTP, TLS (`port+1`), and ICE UDP rules; the helper covers default ports.

Internet mode is optional and uses a Cloudflare Tunnel. The setup window asks for a masked DNS edit token, your own hostname, the Cloudflare Zone ID, and an optional Wrangler path. It does not require or reference another project checkout. Existing `data/cloudflare.json` metadata is used as the initial form value.

1. Obtain Wrangler through the official Cloudflare documentation, sign in with `wrangler login`, and verify the account with `wrangler whoami`.
2. For the EXE, run `%LOCALAPPDATA%\Linchuan\app\scripts\配置固定域名.cmd`. Enter a dedicated subdomain and Zone ID, and check the exact DNS record shown by the window.
3. Choose **Quit Linchuan**, then double-click **Linchuan.exe** again. The native app starts an already configured tunnel automatically. `--local` forces LAN-only mode.

The package includes a pinned Cloudflare runtime binary. Source builds use `node scripts/fetch-runtime.mjs` to download the official release and verify its pinned SHA-256.

## Data and privacy

Under the data directory, chat, device, and file indexes are stored in `linchuan.sqlite`; file bodies are in `uploads` and generated previews are in `previews`. Source/folder launches use the project/package's `data`; the EXE uses the separate AppData location above. Data is persistent by default and is not disk-encrypted. A device can hide its own messages without deleting the original file or another device's history. Stop the service before backing up the complete data directory. The tunnel credential is protected by the current Windows user; full host transfer re-protects it on the destination. Never publish the data directory.

Initial LAN webpage loading and explicit HTTP pairing use HTTP. Automatic native LAN routes use group-pinned TLS, phone direct channels use WebRTC DTLS, and internet traffic uses HTTPS/WSS. This is transport encryption, not end-to-end encryption between devices: the host can read chat and files. A six-digit join code should be shared only with trusted people. Manual copying of a DPAPI credential to another user or computer does not work; use full host transfer or configure it again.

## Troubleshooting

- If another device cannot connect, confirm both devices are on the same non-guest Wi-Fi and that AP isolation is disabled.
- Run `允许局域网访问.cmd` as administrator to create the program-specific local-subnet TCP/UDP rules.
- If a VPN or virtual adapter is present, choose the LAN address associated with the home router.
- Internet status is shown in the native host window. The host must remain running, online, and awake for other devices to connect.
- The connection menu includes `http://127.0.0.1:3939`, detected LAN URLs, and the saved HTTPS hostname. Loopback works only on the host itself. A listed hostname does not prove the tunnel is connected; check its status too.
- Source/folder launches and the single EXE use different data directories. When migrating the previous web host, keep `cloudflare.json` and `tunnel-token.dpapi` together under the actual EXE data directory, for the same Windows user. Packaged development tools may redirect AppData file access. Run the app/setup from File Explorer and verify the actual location. Do not overwrite an existing chat database.
- Cloudflare error 1033 means no healthy tunnel connector is available. If the page loads but a native client gets HTTP 403 or a browser challenge, inspect browser-only challenge rules for the dedicated hostname's `/api/` and `/ws`. Native requests declare a normal `Linchuan/<version>` User-Agent, allowing empty-User-Agent rules to remain enabled. Native clients cannot complete JavaScript challenges. Scope any adjustment to the service hostname and endpoints while retaining application authentication, rate limits, and other sites' protections.

## Development and checks

The Windows client confirms copied messages, addresses and connection codes with a short notice and a green check or “Copied” button state. Feedback resets after about two seconds without moving focus or changing button width. Empty content and clipboard errors show a localized failure notice; copied content is never included in the notice.

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
npm run test:network-browser
npx tsx scripts/language-check.ts
npx tsx scripts/visual-check.ts
node scripts/fetch-runtime.mjs
npm run package
dotnet build native/Linchuan.Desktop/Linchuan.Desktop.csproj -c Release
dotnet run --project native/Linchuan.Desktop.Tests -c Release
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/test-desktop.ps1
```

Building the native app requires the .NET 10 SDK and PowerShell 7 on Windows; end users need no separate runtime installation. Browser and native tests use isolated temporary data. The native harness exercises actual WPF controls, WebSocket presence, privacy, multi-chunk SHA-256 transfer, gallery, four languages and both themes, and writes screenshots under `qa/native`.

For source development, install Node.js 24.14.1 or newer and run `npm ci`; use `npm start` after building. For hot reload, run `npm run server:dev` and `npm run dev` separately.

Both interfaces support **Simplified Chinese, English, Korean, and Japanese**, round flags, and light, charcoal dark, and system themes. WPF consumes the same `src/tokens.css` and language catalogs as the phone web interface. Chat text and user-defined device names are never translated. A local Windows user can explicitly select a previous computer identity during joining to retain its private history and hidden messages. This identity import API rejects remote and browser-origin requests.

There is no artificial file-type or single-file size limit. Files use streamed 8 MiB chunks, with at most 20 files selected at once and a 256 MiB free-disk reserve on the server; disk, network, and platform capabilities still apply. Native downloads replace their destination only after success. Native image previews use generated PNGs; the original file remains unchanged and downloadable. Wheel zoom, drag, arrow navigation, copy, and per-device deletion are provided in WPF. Native videos are downloaded to a temporary cache before playback and depend on Windows codecs. Unsupported media remain downloadable. Phone media cards have one **Save** action, with system share or original-file download fallback; webpages cannot silently write to a phone's photo library.
