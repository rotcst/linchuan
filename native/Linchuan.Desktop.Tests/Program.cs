using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.Net.Sockets;
using System.Net;
using System.Net.Http;
using System.Reflection;
using Linchuan.Desktop.Core;

namespace Linchuan.Desktop.Tests;

internal static class Program
{
    public static async Task<int> Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "linchuan-native-core-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await RejectsUnsafePayloadAsync(root);
            await RejectsUndeclaredPayloadAsync(root);
            await AcceptsManifestPayloadAsync(root);
            await FailedPayloadLeavesExistingAppUntouchedAsync(root);
            await RejectsDuplicateAndBadHashAsync(root);
            await RejectsReparseTargetsAsync(root);
            await SettingsDoNotPersistPlainTokenAsync(root);
            await RestoreFailureClearsSessionAsync();
            await LegacyServiceIsRejectedBeforeExtractionAsync(root);
            PublicUrlMetadataBoundaries(root);
            await ReuseRequiresMatchingPublicUrlAsync(root);
            await ReuseRequiresMatchingGroupAsync(root);
            await PendingServiceReuseAsync(root);
            HostTransferPublicConfiguration(root);
            await UpdateCheckerValidationAsync();
            await NativeRequestIdentityAsync();
            HostTransferCryptography();
            HostTransferRestartRecovery(root);
            Assert(new UploadProgress { UploadedBytes = 20, TotalBytes = 10 }.Percent == 100, "上传进度上限");
            Assert(new UploadProgress { UploadedBytes = -1, TotalBytes = 10 }.Percent == 0, "上传进度下限");
            Assert(new UploadProgress { UploadedBytes = long.MaxValue, TotalBytes = long.MaxValue }.Percent == 100, "大整数进度");
            ClipboardFileDropTests();
            await RealServiceReconnectAsync(root);
            Console.WriteLine("native core security tests passed");
            return 0;
        }
        finally { try { Directory.Delete(root, recursive: true); } catch { } }
    }

    private static void ClipboardFileDropTests()
    {
        var data = new System.Windows.DataObject();
        data.SetData(System.Windows.DataFormats.FileDrop, new[] { "C:\\QA\\archive.zip", "C:\\QA\\archive.zip", "C:\\QA\\photo.png" });
        var paths = Linchuan.Desktop.ClipboardFileDrop.TryGetPaths(data);
        Assert(paths is not null && paths.SequenceEqual(new[] { "C:\\QA\\archive.zip", "C:\\QA\\photo.png" }, StringComparer.OrdinalIgnoreCase), "clipboard FileDrop supports multiple distinct files");
        var text = new System.Windows.DataObject(System.Windows.DataFormats.UnicodeText, "not a file");
        Assert(Linchuan.Desktop.ClipboardFileDrop.TryGetPaths(text) is null, "clipboard text does not become upload");
    }

    private static async Task UpdateCheckerValidationAsync()
    {
        Assert(UpdateChecker.ParseStableVersion("v1.2.3") == new Version(1, 2, 3), "stable version parsing");
        Assert(UpdateChecker.ParseStableVersion("1.2.3-beta") is null, "pre-release rejected");
        Assert(!UpdateChecker.TryReleaseUrl("https://evil.example/releases/tag/v1.2.0", out _), "foreign release URL rejected");
        Assert(!UpdateChecker.TryReleaseUrl("http://github.com/rotcst/linchuan/releases/tag/v1.2.0", out _), "non-HTTPS release URL rejected");
        Assert(!UpdateChecker.TryReleaseUrl("https://user@github.com/rotcst/linchuan/releases/tag/v1.2.0", out _), "credential-bearing release URL rejected");
        Assert(!UpdateChecker.TryReleaseUrl("https://github.com:8443/rotcst/linchuan/releases/tag/v1.2.0", out _), "nonstandard release port rejected");
        Assert(!UpdateChecker.TryReleaseUrl("https://github.com/rotcst/linchuan/releases/other", out _), "non-tag release URL rejected");
        using var handler = new StubHandler("{\"tag_name\":\"v9.0.0\",\"draft\":false,\"html_url\":\"https://github.com/rotcst/linchuan/releases/tag/v9.0.0\"}");
        using var checker = new UpdateChecker(handler, TimeSpan.FromSeconds(2));
        var result = await checker.CheckAsync();
        Assert(result.Status == UpdateStatus.UpdateAvailable, "update availability status");
        Assert(result.ReleaseUrl?.Host == "github.com", "official release URL");
        Assert(handler.UserAgent.Contains("Linchuan/"), "GitHub request User-Agent");
        using var equalHandler = new StubHandler(JsonSerializer.Serialize(new { tag_name = "v" + UpdateChecker.CurrentVersion().ToString(3), html_url = "https://github.com/rotcst/linchuan/releases/tag/v" + UpdateChecker.CurrentVersion().ToString(3) }));
        using var equalChecker = new UpdateChecker(equalHandler);
        Assert((await equalChecker.CheckAsync()).Status == UpdateStatus.NoUpdate, "three-part Release equals four-part assembly version");
        using var prereleaseHandler = new StubHandler("{\"tag_name\":\"v9.0.0\",\"prerelease\":true,\"html_url\":\"https://github.com/rotcst/linchuan/releases/tag/v9.0.0\"}");
        using var prereleaseChecker = new UpdateChecker(prereleaseHandler);
        Assert((await prereleaseChecker.CheckAsync()).Status == UpdateStatus.NoRelease, "prerelease flag rejected");
        using var invalidHandler = new StubHandler("{\"tag_name\":42}");
        using var invalidChecker = new UpdateChecker(invalidHandler);
        Assert((await invalidChecker.CheckAsync()).Status == UpdateStatus.NetworkError, "malformed metadata is not an up-to-date result");
    }

    private static void HostTransferCryptography()
    {
        using var keyPair = RSA.Create(2048);
        var group = new GroupNetwork { Protocol = 1, GroupId = Guid.NewGuid().ToString(), PublicKey = Convert.ToBase64String(keyPair.ExportSubjectPublicKeyInfo()), HostGeneration = 1 };
        using var routes = new NetworkRoutes(new Uri("https://transfer.example.test")); routes.Pin(group);
        var rejected = false; try { routes.Pin(new GroupNetwork { Protocol = 1, GroupId = group.GroupId, PublicKey = group.PublicKey, HostGeneration = 0 }); } catch (InvalidDataException) { rejected = true; } Assert(rejected, "主机代次不能倒退");
        var certificateRequest = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=fixture", keyPair, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var certificate = certificateRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
        Assert(NetworkRoutes.ValidateCertificate(new Uri("https://192.168.31.84:3940"), certificate, System.Net.Security.SslPolicyErrors.RemoteCertificateChainErrors, group), "局域网TLS匹配组公钥");
        using var foreign = RSA.Create(2048); using var foreignCert = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=foreign", foreign, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1).CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
        Assert(!NetworkRoutes.ValidateCertificate(new Uri("https://192.168.31.84:3940"), foreignCert, System.Net.Security.SslPolicyErrors.None, group), "局域网TLS陌生证书即使有效也拒绝");
        Assert(!NetworkRoutes.ValidateCertificate(new Uri("https://transfer.example.test"), certificate, System.Net.Security.SslPolicyErrors.RemoteCertificateChainErrors, group), "公网不能绕过证书链验证");
        var offer = new HandoffOffer { Id = Guid.NewGuid().ToString("N"), GroupId = group.GroupId, Generation = 2, TargetDeviceId = "target-fixture", ReceivePort = 3939, TotalChunks = 1, TotalBytes = 100, Sha256 = new string('a', 64), EnvelopeJson = "{}" };
        var envelopeHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(offer.EnvelopeJson)));
        var signed = $"linchuan-handoff-v1\n{offer.Id}\n{offer.GroupId}\n{offer.Generation}\n{offer.TargetDeviceId}\n{offer.TotalChunks}\n{offer.TotalBytes}\n{offer.Sha256}\n{envelopeHash}";
        offer.Signature = Convert.ToBase64String(keyPair.SignData(Encoding.UTF8.GetBytes(signed), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)); HostHandoff.VerifyOffer(offer, group);
        var pendingRoot = Path.Combine(
            Path.GetTempPath(),
            "linchuan-pending-validation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(pendingRoot);
        try
        {
            var incoming = new HandoffPending { Offer = offer, DataDir = Path.Combine(pendingRoot, "groups", offer.GroupId + "-2") };
            HostHandoff.ValidatePendingForStartup(incoming, group, pendingRoot);
            HostHandoff.ValidatePendingForStartup(new HandoffPending { Offer = offer, Outgoing = true }, group, pendingRoot);
            var wrongGroup = new GroupNetwork
            {
                Protocol = group.Protocol,
                GroupId = Guid.NewGuid().ToString(),
                PublicKey = group.PublicKey,
                HostGeneration = group.HostGeneration,
            };
            AssertThrows<InvalidDataException>(
                () => HostHandoff.ValidatePendingForStartup(incoming, wrongGroup, pendingRoot),
                "pending错误组拒绝");
            var wrongGeneration = new HandoffOffer
            {
                Id = offer.Id,
                GroupId = offer.GroupId,
                Generation = 3,
                TargetDeviceId = offer.TargetDeviceId,
                ReceivePort = offer.ReceivePort,
                TotalChunks = offer.TotalChunks,
                TotalBytes = offer.TotalBytes,
                Sha256 = offer.Sha256,
                EnvelopeJson = offer.EnvelopeJson,
                Signature = offer.Signature,
            };
            AssertThrows<InvalidDataException>(
                () => HostHandoff.ValidatePendingForStartup(new HandoffPending { Offer = wrongGeneration, Outgoing = true }, group, pendingRoot),
                "pending错误代次拒绝");
            var tampered = new HandoffOffer
            {
                Id = offer.Id,
                GroupId = offer.GroupId,
                Generation = offer.Generation,
                TargetDeviceId = offer.TargetDeviceId,
                ReceivePort = offer.ReceivePort,
                TotalChunks = offer.TotalChunks,
                TotalBytes = offer.TotalBytes,
                Sha256 = offer.Sha256,
                EnvelopeJson = offer.EnvelopeJson,
                Signature = Convert.ToBase64String(RandomNumberGenerator.GetBytes(256)),
            };
            AssertThrows<InvalidDataException>(
                () => HostHandoff.ValidatePendingForStartup(new HandoffPending { Offer = tampered, Outgoing = true }, group, pendingRoot),
                "pending篡改拒绝");
        }
        finally { try { Directory.Delete(pendingRoot, true); } catch { } }
        offer.EnvelopeJson = "{\"tampered\":true}"; rejected = false; try { HostHandoff.VerifyOffer(offer, group); } catch (InvalidDataException) { rejected = true; } Assert(rejected, "密文头篡改拒绝");
        var key = RandomNumberGenerator.GetBytes(32); var prefix = RandomNumberGenerator.GetBytes(8); var plain = Encoding.UTF8.GetBytes("完整移交 synthetic credential");
        try
        {
            var cipher = HostHandoff.Encrypt(plain, key, prefix, offer, 0); Assert(HostHandoff.Decrypt(cipher, key, prefix, offer, 0).SequenceEqual(plain), "AES-GCM移交解密");
            rejected = false; try { HostHandoff.Decrypt(cipher, key, prefix, offer, 1); } catch (CryptographicException) { rejected = true; } Assert(rejected, "密文块次序绑定");
            offer.TargetDeviceId = "wrong-target"; rejected = false; try { HostHandoff.Decrypt(cipher, key, prefix, offer, 0); } catch (CryptographicException) { rejected = true; } Assert(rejected, "密文绑定目标身份");
            cipher[16] ^= 1; rejected = false; try { HostHandoff.Decrypt(cipher, key, prefix, offer, 0); } catch (CryptographicException) { rejected = true; } Assert(rejected, "密文篡改拒绝");
        }
        finally { CryptographicOperations.ZeroMemory(key); CryptographicOperations.ZeroMemory(plain); }
    }

    private static void HostTransferRestartRecovery(string root)
    {
        var path = Path.Combine(root, "receiver", "handoff-receive-key.dpapi"); byte[] publicKey; byte[] wrapped;
        var secret = RandomNumberGenerator.GetBytes(32);
        try
        {
            using (var first = HostHandoff.LoadReceiveKey(path)) { publicKey = first.ExportSubjectPublicKeyInfo(); wrapped = first.Encrypt(secret, RSAEncryptionPadding.OaepSHA256); Assert(!File.ReadAllBytes(path).AsSpan().SequenceEqual(first.ExportPkcs8PrivateKey()), "接收私钥由DPAPI保护"); }
            using (var restarted = HostHandoff.LoadReceiveKey(path)) { Assert(publicKey.SequenceEqual(restarted.ExportSubjectPublicKeyInfo()), "重启保持移交接收公钥"); Assert(restarted.Decrypt(wrapped, RSAEncryptionPadding.OaepSHA256).SequenceEqual(secret), "重启仍能解开已密封移交"); }
            File.WriteAllBytes(path, [1, 2, 3]); var rejected = false; try { using var invalid = HostHandoff.LoadReceiveKey(path); } catch (CryptographicException) { rejected = true; } Assert(rejected, "损坏接收密钥不能静默替换");
            var offer = new HandoffOffer { GroupId = Guid.NewGuid().ToString(), Generation = 2, Id = Guid.NewGuid().ToString("N") };
            var pending = new HandoffPending { Offer = offer, DataDir = Path.Combine(root, "groups", offer.GroupId + "-2") };
            var stage = pending.DataDir + ".staging-" + offer.Id; Directory.CreateDirectory(stage); File.WriteAllText(Path.Combine(stage, "linchuan.sqlite"), "verified fixture");
            HostHandoff.RestoreImportDirectory(root, pending); Assert(!Directory.Exists(stage) && File.ReadAllText(Path.Combine(pending.DataDir, "linchuan.sqlite")) == "verified fixture", "已校验导入在目录切换前崩溃可恢复");
            HostHandoff.RestoreImportDirectory(root, pending); Assert(Directory.Exists(pending.DataDir), "导入恢复幂等");
            Directory.CreateDirectory(stage); File.WriteAllText(Path.Combine(stage, "bundle.zip"), "unused stage"); HostHandoff.RestoreImportDirectory(root, pending); Assert(!Directory.Exists(stage), "恢复清理同事务残留stage");
            pending.DataDir = root; rejected = false; try { HostHandoff.RestoreImportDirectory(root, pending); } catch (InvalidDataException) { rejected = true; } Assert(rejected, "恢复拒绝越界数据目录");
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }
    private static async Task NativeRequestIdentityAsync()
    {
        var allocation = new TcpListener(IPAddress.Loopback, 0); allocation.Start(); var port = ((IPEndPoint)allocation.LocalEndpoint).Port; allocation.Stop();
        using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
        var expected = "Linchuan/" + UpdateChecker.CurrentVersion().ToString(3);
        var captured = new List<string?>();
        var server = Task.Run(async () =>
        {
            var http = await listener.GetContextAsync(); captured.Add(http.Request.UserAgent);
            var bytes = Encoding.UTF8.GetBytes("{\"device\":{\"id\":\"identity-fixture\",\"type\":\"computer\"},\"devices\":[]}");
            http.Response.ContentType = "application/json"; http.Response.ContentLength64 = bytes.Length; await http.Response.OutputStream.WriteAsync(bytes); http.Response.Close();
            var upgrade = await listener.GetContextAsync(); captured.Add(upgrade.Request.UserAgent);
            Assert(upgrade.Request.Headers["Origin"] == $"http://127.0.0.1:{port}", "WebSocket keeps matching origin");
            Assert(upgrade.Request.Headers["Cookie"] == "linchuan_session=fixture-session", "WebSocket keeps authenticated cookie");
            var accepted = await upgrade.AcceptWebSocketAsync(null);
            using var socket = accepted.WebSocket;
            await socket.CloseAsync(System.Net.WebSockets.WebSocketCloseStatus.NormalClosure, "fixture", CancellationToken.None);
        });
        await using var client = new LanClient(new Uri($"http://127.0.0.1:{port}"));
        Assert(await client.RestoreAsync("fixture-session") is not null, "identity fixture restores session");
        await client.ConnectSocketAsync();
        await server.WaitAsync(TimeSpan.FromSeconds(5));
        Assert(captured.Count == 2 && captured.All(value => value == expected), "HTTP and WebSocket declare the same versioned native User-Agent");
    }

    private sealed class StubHandler(string body) : HttpMessageHandler
    {
        public string UserAgent { get; private set; } = "";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            UserAgent = string.Join(" ", request.Headers.UserAgent);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private static async Task RejectsDuplicateAndBadHashAsync(string root)
    {
        await AssertRejectsAsync(root, "build/a.txt", "错误 hash", includeExtra: false, hashOverride: new string('0', 64));
        await AssertRejectsAsync(root, "build/a.txt", "重复 manifest", includeExtra: false, duplicateManifest: true);
    }

    private static async Task RejectsReparseTargetsAsync(string root)
    {
        var link = Path.Combine(root, "link");
        try
        {
            Directory.CreateSymbolicLink(link, root);
            var parentDestination = Path.Combine(root, "parent-target"); Directory.CreateDirectory(parentDestination);
            Directory.CreateSymbolicLink(Path.Combine(parentDestination, "link"), root);
            await AssertRejectsAsync(root, "link/file.txt", "父目录 reparse", destination: parentDestination);
            var targetDestination = Path.Combine(root, "file-target"); Directory.CreateDirectory(targetDestination);
            var real = Path.Combine(targetDestination, "real.txt"); await File.WriteAllTextAsync(real, "old");
            File.CreateSymbolicLink(Path.Combine(targetDestination, "target.txt"), real);
            await AssertRejectsAsync(root, "target.txt", "目标 reparse", destination: targetDestination);
        }
        catch (UnauthorizedAccessException) { Console.WriteLine("reparse test skipped: symbolic-link privilege unavailable"); }
        catch (IOException) { Console.WriteLine("reparse test skipped: symbolic-link privilege unavailable"); }
        catch (PlatformNotSupportedException) { Console.WriteLine("reparse test skipped: platform unavailable"); }
    }

    private static async Task SettingsDoNotPersistPlainTokenAsync(string root)
    {
        var path = Path.Combine(root, "settings.json");
        var store = new SettingsStore(path);
        const string secret = "session-token-that-must-not-be-plaintext";
        await store.SaveAsync(new DesktopSettings { ServerUri = "http://127.0.0.1:41234", DeviceId = "device", SessionToken = secret });
        var text = await File.ReadAllTextAsync(path);
        Assert(!text.Contains(secret, StringComparison.Ordinal), "session token 明文落盘");
        Assert((await store.LoadAsync("http://127.0.0.1:41234", "device"))?.SessionToken == secret, "DPAPI token roundtrip");
    }

    private static async Task RestoreFailureClearsSessionAsync()
    {
        await using var client = new LanClient(new Uri("http://127.0.0.1:1/"));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        try { await client.RestoreAsync("stale-token", cancellation.Token); throw new InvalidOperationException("取消恢复未失败"); }
        catch (OperationCanceledException) { }
        Assert(client.Session is null, "恢复失败保留伪会话");
    }

    private static async Task LegacyServiceIsRejectedBeforeExtractionAsync(string root)
    {
        var listener = new TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        var responseTask = Task.Run(async () =>
        {
            using var connection = await listener.AcceptTcpClientAsync();
            await using var stream = connection.GetStream();
            var buffer = new byte[1024];
            _ = await stream.ReadAsync(buffer);
            var body = Encoding.UTF8.GetBytes("{\"serverName\":\"邻传\",\"desktopApi\":1}");
            var header = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(header);
            await stream.WriteAsync(body);
        });
        var appDir = Path.Combine(root, "legacy-app");
        var dataDir = Path.Combine(root, "legacy-data");
        try
        {
            try
            {
                await new BackendHost().StartAsync(appDir, dataDir, port, true);
                throw new InvalidOperationException("旧版服务未被拒绝");
            }
            catch (InvalidOperationException ex) when (ex.Message.Contains("旧版服务", StringComparison.Ordinal)) { }
            await responseTask;
            Assert(!Directory.Exists(appDir), "旧版服务拒绝后仍提取 payload");
        }
        finally { listener.Stop(); }
    }

    private static async Task ReuseRequiresMatchingPublicUrlAsync(string root)
    {
        foreach (var (configured, advertised, reuse) in new (string?, string?, bool)[] { (null, null, true), ("https://transfer.example.test", "https://transfer.example.test", true), ("https://transfer.example.test", null, false), ("https://transfer.example.test", "https://other.example.test", false), (null, "https://transfer.example.test", false) })
        {
            var directory = Path.Combine(root, "reuse-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
            if (configured is not null) await File.WriteAllTextAsync(Path.Combine(directory, "cloudflare.json"), JsonSerializer.Serialize(new { publicUrl = configured }));
            using var listener = new TcpListener(System.Net.IPAddress.Loopback, 0); listener.Start(); var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
            var reply = Task.Run(async () => { using var connection = await listener.AcceptTcpClientAsync(); await using var stream = connection.GetStream(); _ = await stream.ReadAsync(new byte[1024]); var body = JsonSerializer.SerializeToUtf8Bytes(new { serverName = "邻传", desktopApi = 3, publicUrl = advertised }); await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n")); await stream.WriteAsync(body); });
            try
            {
                await using var host = new BackendHost(); var rejected = false;
                try { Assert(!await host.StartAsync(Path.Combine(directory, "app"), directory, port, true), "匹配的现有服务应复用而非新建"); }
                catch (InvalidOperationException ex) when (ex.Message.Contains("公网入口配置", StringComparison.Ordinal)) { rejected = true; }
                Assert(rejected == !reuse, "仅复用公网配置匹配的现有服务"); await reply; Assert(!Directory.Exists(Path.Combine(directory, "app")), "复用或拒绝时不改动服务程序目录");
            }
            finally { listener.Stop(); }
        }
    }
    private static async Task ReuseRequiresMatchingGroupAsync(string root)
    {
        var groupId = Guid.NewGuid().ToString();
        foreach (var (advertisedGroup, generation, reuse) in new (string?, long, bool)[] { (groupId, 2, true), (Guid.NewGuid().ToString(), 2, false), (groupId, 1, false), (null, 0, false) })
        {
            var directory = Path.Combine(root, "reuse-group-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
            using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var reply = Task.Run(async () => { using var connection = await listener.AcceptTcpClientAsync(); await using var stream = connection.GetStream(); _ = await stream.ReadAsync(new byte[1024]); var body = JsonSerializer.SerializeToUtf8Bytes(new { serverName = "邻传", desktopApi = 3, groupId = advertisedGroup, hostGeneration = generation }); await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n")); await stream.WriteAsync(body); });
            await using var backend = new BackendHost(); var rejected = false;
            try { Assert(!await backend.StartAsync(Path.Combine(directory, "app"), directory, port, true, expectedNetwork: new GroupNetwork { GroupId = groupId, HostGeneration = 2 }), "仅复用移交设备组的服务"); }
            catch (InvalidOperationException ex) when (ex.Message.Contains("本次移交的设备组", StringComparison.Ordinal)) { rejected = true; }
            Assert(rejected == !reuse, "拒绝独立服务及旧主机代次"); await reply; Assert(!Directory.Exists(Path.Combine(directory, "app")), "拒绝其他服务时保留其程序与数据");
        }
    }
    private static async Task PendingServiceReuseAsync(string root)
    {
        using var key = RSA.Create(2048);
        var group = new GroupNetwork { Protocol = 1, GroupId = Guid.NewGuid().ToString(), PublicKey = Convert.ToBase64String(key.ExportSubjectPublicKeyInfo()), HostGeneration = 1 };
        var offer = new HandoffOffer { Id = Guid.NewGuid().ToString("N"), GroupId = group.GroupId, Generation = 2, TargetDeviceId = Guid.NewGuid().ToString(), ReceivePort = 40000, TotalChunks = 1, TotalBytes = 17, Sha256 = new string('a', 64), EnvelopeJson = "{}" };
        var envelopeHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(offer.EnvelopeJson)));
        var signed = $"linchuan-handoff-v1\n{offer.Id}\n{offer.GroupId}\n{offer.Generation}\n{offer.TargetDeviceId}\n{offer.TotalChunks}\n{offer.TotalBytes}\n{offer.Sha256}\n{envelopeHash}";
        offer.Signature = Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(signed), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        foreach (var (outgoing, advertisedGroup, generation, reuse) in new (bool, string, long, bool)[] { (true, group.GroupId, 1, true), (true, group.GroupId, 2, true), (true, group.GroupId, 3, false), (true, Guid.NewGuid().ToString(), 2, false), (false, group.GroupId, 1, false), (false, group.GroupId, 2, true), (false, group.GroupId, 3, false), (false, Guid.NewGuid().ToString(), 2, false) })
        {
            var caseRoot = Path.Combine(root, "pending-reuse-" + Guid.NewGuid().ToString("N"));
            var dataDir = outgoing ? caseRoot : Path.Combine(caseRoot, "groups", group.GroupId + "-2"); Directory.CreateDirectory(dataDir);
            var pending = new HandoffPending { Offer = offer, Outgoing = outgoing, DataDir = outgoing ? "" : dataDir };
            using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var reply = Task.Run(async () =>
            {
                using var connection = await listener.AcceptTcpClientAsync(); await using var stream = connection.GetStream(); _ = await stream.ReadAsync(new byte[1024]);
                var body = JsonSerializer.SerializeToUtf8Bytes(new { serverName = "邻传", desktopApi = 3, groupId = advertisedGroup, hostGeneration = generation });
                await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n")); await stream.WriteAsync(body);
            });
            await using var backend = new BackendHost(); var rejected = false;
            try { Assert(!await backend.StartAsync(Path.Combine(caseRoot, "app"), dataDir, port, true, expectedNetwork: group, pendingHandoff: pending), "signed pending can resume matching service without extracting payload"); }
            catch (InvalidOperationException ex) when (ex.Message.Contains("本次移交的设备组", StringComparison.Ordinal)) { rejected = true; }
            Assert(rejected == !reuse, "pending accepts only the source before/after commit or the activated target generation"); await reply;
            Assert(!Directory.Exists(Path.Combine(caseRoot, "app")), "pending rejection preserves another service and its data");
        }
    }
    private static void HostTransferPublicConfiguration(string root)
    {
        var directory = Path.Combine(root, "transfer-public"); Directory.CreateDirectory(directory);
        const string domain = "https://transfer.example.test";
        HostHandoff.ValidatePublicConfiguration(directory, null);
        File.WriteAllText(Path.Combine(directory, "cloudflare.json"), JsonSerializer.Serialize(new { publicUrl = domain }));
        var rejected = false; try { HostHandoff.ValidatePublicConfiguration(directory, null); } catch (InvalidDataException) { rejected = true; } Assert(rejected, "本机公网配置不能在路由元数据为空时被静默跳过");
        rejected = false; try { HostHandoff.ValidatePublicConfiguration(directory, domain); } catch (InvalidDataException) { rejected = true; } Assert(rejected, "有域名却无凭据不能提交完整移交");
        var plain = Encoding.UTF8.GetBytes("synthetic-fixture-token");
        try { File.WriteAllBytes(Path.Combine(directory, "tunnel-token.dpapi"), ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser)); HostHandoff.ValidatePublicConfiguration(directory, domain); }
        finally { CryptographicOperations.ZeroMemory(plain); }
        File.Delete(Path.Combine(directory, "cloudflare.json"));
        rejected = false; try { HostHandoff.ValidatePublicConfiguration(directory, domain); } catch (InvalidDataException) { rejected = true; } Assert(rejected, "接收恢复缺少公网配置必须明确拒绝");
    }
    private static void PublicUrlMetadataBoundaries(string root)
    {
        var method = typeof(BackendHost).GetMethod("ReadPublicUrl", BindingFlags.Public | BindingFlags.Static)!;
        var path = Path.Combine(root, "public-url-data"); Directory.CreateDirectory(path);
        string? Read(string json)
        {
            File.WriteAllText(Path.Combine(path, "cloudflare.json"), json);
            return (string?)method.Invoke(null, [path]);
        }
        Assert(Read("{\"publicUrl\":\"https://transfer.example.test/path\"}") == "https://transfer.example.test", "公网 URL 归一化");
        Assert(Read("{\"publicUrl\":\"http://transfer.example.test\"}") is null, "公网 URL 拒绝 HTTP");
        Assert(Read("{\"publicUrl\":\"https://user:pass@transfer.example.test\"}") is null, "公网 URL 拒绝凭据");
        Assert(Read("{\"publicUrl\":\"not-a-url\"}") is null, "公网 URL 拒绝非法值");
        File.WriteAllText(Path.Combine(path, "cloudflare.json"), "{\"publicUrl\":\"https://transfer.example.test\"}", new UTF8Encoding(true));
        Assert((string?)method.Invoke(null, [path]) == "https://transfer.example.test", "兼容 PowerShell UTF-8 BOM 配置");
        var malformedRejected = false;
        try { Read("{"); }
        catch (TargetInvocationException ex) when (ex.InnerException is InvalidOperationException) { malformedRejected = true; }
        Assert(malformedRejected, "损坏配置报错而不静默关闭公网入口");
        File.Delete(Path.Combine(path, "cloudflare.json"));
        Assert((string?)method.Invoke(null, [path]) is null, "缺失公网 URL 元数据");
    }

    private static async Task RejectsUnsafePayloadAsync(string root)
    {
        await AssertRejectsAsync(root, "../escape.txt", "非法相对路径");
    }

    private static async Task RejectsUndeclaredPayloadAsync(string root)
    {
        await AssertRejectsAsync(root, "declared.txt", "未声明文件", includeExtra: true);
    }

    private static async Task AcceptsManifestPayloadAsync(string root)
    {
        const string relative = "build/server.cjs";
        const string content = "safe";
        await using var zip = CreateZip(relative, content, includeExtra: false);
        zip.Position = 0;
        var destination = Path.Combine(root, "accepted");
        await BackendHost.ExtractPayload(zip, destination);
        Assert(await File.ReadAllTextAsync(Path.Combine(destination, relative)) == content, "manifest 文件解包");
    }

    private static async Task FailedPayloadLeavesExistingAppUntouchedAsync(string root)
    {
        var destination = Path.Combine(root, "atomic");
        Directory.CreateDirectory(destination);
        await File.WriteAllTextAsync(Path.Combine(destination, "old.txt"), "old-version");
        await using var zip = CreateTwoFileZip(("first.txt", "new-first", null), ("second.txt", "new-second", new string('0', 64)));
        try
        {
            await BackendHost.ExtractPayload(zip, destination);
            throw new InvalidOperationException("错误 hash 未拒绝");
        }
        catch (InvalidDataException) { }
        Assert(await File.ReadAllTextAsync(Path.Combine(destination, "old.txt")) == "old-version", "失败解包破坏旧目录");
        Assert(!File.Exists(Path.Combine(destination, "first.txt")), "失败解包留下新文件");
        Assert(!Directory.GetDirectories(root, ".atomic.staging-*", SearchOption.TopDirectoryOnly).Any(), "失败解包留下 staging");
    }

    private static async Task AssertRejectsAsync(string root, string relative, string expected, bool includeExtra = false, string? hashOverride = null, bool duplicateManifest = false, string? destination = null)
    {
        await using var zip = CreateZip(relative, "payload", includeExtra, hashOverride, duplicateManifest);
        zip.Position = 0;
        try
        {
            await BackendHost.ExtractPayload(zip, destination ?? Path.Combine(root, Guid.NewGuid().ToString("N")));
            throw new InvalidOperationException("未拒绝 " + expected);
        }
        catch (InvalidDataException) { }
    }

    private static MemoryStream CreateZip(string relative, string content, bool includeExtra, string? hashOverride = null, bool duplicateManifest = false)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        var hash = hashOverride ?? Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entry = archive.CreateEntry(relative.Replace('\\', '/'));
            using (var output = entry.Open()) output.Write(bytes, 0, bytes.Length);
            var manifest = archive.CreateEntry("manifest.json");
            var manifestJson = $"{{\"files\":{{\"{relative.Replace("\\", "/")}\":\"{hash}\"{(duplicateManifest ? $",\"{relative.Replace("\\", "/")}\":\"{hash}\"" : string.Empty)}}}}}";
            var manifestBytes = Encoding.UTF8.GetBytes(manifestJson);
            using (var output = manifest.Open()) output.Write(manifestBytes, 0, manifestBytes.Length);
            if (includeExtra)
            {
                var extra = Encoding.UTF8.GetBytes("extra");
                using var output = archive.CreateEntry("extra.txt").Open();
                output.Write(extra, 0, extra.Length);
            }
        }
        stream.Position = 0;
        return stream;
    }

    private static MemoryStream CreateTwoFileZip(params (string Relative, string Content, string? Hash)[] files)
    {
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            var manifest = new StringBuilder("{\"files\":{");
            for (var i = 0; i < files.Length; i++)
            {
                var item = files[i];
                var bytes = Encoding.UTF8.GetBytes(item.Content);
                var entry = archive.CreateEntry(item.Relative);
                using (var output = entry.Open()) output.Write(bytes, 0, bytes.Length);
                if (i > 0) manifest.Append(',');
                manifest.Append(JsonSerializer.Serialize(item.Relative)).Append(':').Append(JsonSerializer.Serialize(item.Hash ?? Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()));
            }
            manifest.Append("}}");
            using var manifestOutput = archive.CreateEntry("manifest.json").Open();
            var manifestBytes = Encoding.UTF8.GetBytes(manifest.ToString());
            manifestOutput.Write(manifestBytes, 0, manifestBytes.Length);
        }
        stream.Position = 0;
        return stream;
    }

    private static async Task RealServiceReconnectAsync(string root)
    {
        var server = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "build", "server.cjs"));
        if (!File.Exists(server)) { Console.WriteLine("real service test skipped: build/server.cjs missing"); return; }
        var data = Path.Combine(root, "service-data"); Directory.CreateDirectory(data);
        (Process Process, Task<int> Port) Start(int port) { var info = new ProcessStartInfo("node", $"\"{server}\"") { WorkingDirectory = Path.GetDirectoryName(server)!, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true }; info.Environment["DATA_DIR"] = data; info.Environment["PORT"] = port.ToString(); info.Environment["JOIN_CODE"] = "123456"; info.Environment["INTERNET"] = "0"; info.Environment["OPEN_BROWSER"] = "0"; var p = Process.Start(info); if (p is null) throw new InvalidOperationException("无法启动临时 Node 服务"); var portTask = ReadPortAsync(p); _ = p.StandardError.ReadToEndAsync(); return (p, portTask); }
        Process? first = null;
        Process? second = null;
        try
        {
            var started = Start(0); first = started.Process;
            var port = await started.Port.WaitAsync(TimeSpan.FromSeconds(15));
            var baseUri = new Uri($"http://127.0.0.1:{port}/");
            await WaitForInfoAsync(baseUri, first);
            await using var client = new LanClient(baseUri);
            await client.JoinAsync("123456", "native-test", "native-test-device");
            var deviceId = client.Session!.Device.Id;
            var identities = await client.HostDevicesAsync();
            Assert(identities.Any(item => item.Id == deviceId), "桌面身份列表");
            await using var claimed = new LanClient(baseUri);
            await claimed.ClaimDesktopAsync(deviceId, "123456");
            await claimed.ConnectSocketAsync();
            await claimed.LogoutAsync();
            await client.ConnectSocketAsync();
            var reconnected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            client.ConnectionChanged += value => { if (value == "connected") reconnected.TrySetResult(); };
            first.Kill(entireProcessTree: true); await first.WaitForExitAsync();
            var replacement = Start(port); second = replacement.Process;
            await replacement.Port.WaitAsync(TimeSpan.FromSeconds(15));
            await reconnected.Task.WaitAsync(TimeSpan.FromSeconds(15));
            second.Kill(entireProcessTree: true); await second.WaitForExitAsync();
            await client.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            await client.DisposeAsync();
        }
        finally
        {
            foreach (var process in new[] { first, second })
            {
                if (process is null) continue;
                try { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); } } catch { }
                process.Dispose();
            }
        }
    }

    private static async Task<int> ReadPortAsync(Process process)
    {
        while (await process.StandardOutput.ReadLineAsync() is { } line)
        {
            var marker = "http://127.0.0.1:";
            var start = line.IndexOf(marker, StringComparison.Ordinal);
            if (start >= 0 && int.TryParse(line[(start + marker.Length)..].Trim(), out var port)) return port;
        }
        throw new InvalidOperationException($"临时 Node 服务提前退出，exit={process.ExitCode}");
    }

    private static async Task WaitForInfoAsync(Uri uri, Process process)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) };
        for (var i = 0; i < 60; i++) { try { if ((await http.GetAsync(new Uri(uri, "api/info"))).IsSuccessStatusCode) return; } catch { } await Task.Delay(100); }
        throw new TimeoutException($"临时 Node 服务启动超时，退出码: {(process.HasExited ? process.ExitCode : "running")} ");
    }

    private static void Assert(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("测试失败: " + name);
    }

    private static void AssertThrows<T>(Action action, string name) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new InvalidOperationException("测试失败: " + name);
    }
}
