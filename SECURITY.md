# Security policy

## Scope

This policy covers the Linchuan application, its Node.js server, the Windows launchers, and the optional Cloudflare Tunnel setup. It does not cover the user's router, operating system, browser, Cloudflare account, or third-party runtime binaries.

## Current protections

- Joining requires a six-digit code. Join attempts are limited to 20 per source IP per minute and 30 globally per minute. Twenty cumulative wrong codes lock new joins across IP addresses and restarts. Existing sessions remain usable. Only the local service computer can refresh the code and unlock joining.
- Sessions use random 256-bit bearer tokens. HTTP sessions use an HttpOnly, SameSite cookie; HTTPS cookies are marked Secure. WebSocket connections require a valid session, matching Host/Origin, and support same-origin cookie-only handshakes.
- Private messages and files are authorized against both sender and recipient. Public messages and files are limited to authenticated members. File paths are server-generated and uploads reject symlinks, traversal names, extra multipart parts, and oversized streams.
- Uploads are streamed to temporary files, cleaned on abort, and constrained by per-device concurrency, storage budget, and a 256 MiB free-disk reserve. A shared serialized reservation budget accounts for concurrent uploads; completed writes release their reservation so written bytes are not counted twice. Multipart chunks are reserved before writing and released after the complete buffer is written. Media previews validate file signatures before decoding and write through isolated cache files.
- HTTP request bodies have a five-minute deadline. JSON bodies have a separate 15-second deadline, upload inactivity is limited to 120 seconds, and the HTTP server accepts at most 512 concurrent connections.
- API errors do not return stack traces. Responses set no-store for APIs, no-referrer, frame denial, MIME sniffing protection, and a restrictive CSP.
- Tunnel credentials are stored with Windows DPAPI for the current user. DNS tokens are entered through a masked local window and are not written to project files.

## Verified checks

The repository includes isolated integration tests for authentication, Host/Origin checks, WebSocket presence and reconnect, private/public ACLs, upload boundaries, path-safe filenames, media signatures, session expiry, persistence, persistent join locking, concurrent disk reservations, and slow JSON deadlines. The 2026-10-12 local run passed 45 tests, including localization coverage. Online npm audit reported zero known vulnerabilities. Browser regressions cover chat, media, four languages, both themes, shared dropdowns, keyboard interaction, focus styling and responsive layouts. This records checks performed on this revision; it is not a guarantee against future vulnerabilities.

The browser uses a cookie-only WebSocket URL. The server also accepts a query token for older clients; such clients must avoid logging credential-bearing URLs. The bundled Windows launcher verifies every managed file against its embedded SHA-256 manifest and refuses paths outside its managed app directory.

## Limitations

Linchuan is not end-to-end encrypted. LAN mode uses HTTP. The six-digit code is a convenience gate and should only be shared with trusted people. Persistent chat and files are not disk-encrypted. A user with access to the service computer or its `data` directory can read them.

An unauthenticated visitor can deliberately trigger the join lock; the host then needs to refresh the code locally. Disk reservations coordinate Linchuan uploads, but cannot reserve space against unrelated programs writing to the same volume. This is a personal sharing service, not an isolated multi-tenant hosting platform.

The optional internet mode depends on Cloudflare and the user's account configuration. Keep the tunnel hostname private, update Node.js and dependencies, and do not expose the data directory. The source tree intentionally excludes runtime executables, data, credentials, and QA output from version control.

The application does not keep a persistent request audit trail. Process, listener, data-count and available service-log checks can identify some anomalies, but cannot prove that no historic intrusion occurred. A local check found no suspicious service errors or unexpected application devices; it does not constitute an operating-system forensic examination.

## Reporting

Do not include join codes, session cookies, tunnel tokens, private messages, or file contents in a report. Provide a minimal reproduction, affected version or commit, request type and status, and whether the issue reproduces in an isolated temporary data directory. For suspected account or tunnel compromise, revoke the relevant Cloudflare token or tunnel credential first, then report the incident through the repository's private security channel when one is configured.
