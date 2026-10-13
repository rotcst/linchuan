using System.IO.Compression;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Linchuan.Desktop.Core;

public sealed class HandoffPending
{
    public HandoffOffer Offer { get; set; } = new();
    public string Source { get; set; } = "";
    public string DataDir { get; set; } = "";
    public bool Outgoing { get; set; }
}

/// <summary>Authenticated, encrypted, staged host transfer. No tunnel secret is written in plaintext.</summary>
public sealed class HostHandoff : IAsyncDisposable
{
    private const int ChunkPlainBytes = 8 * 1024 * 1024 - 16;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly RSA _receiveKey;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _root, _pendingFile;
    private readonly int _port;
    private readonly Func<HandoffPending, Task> _activate;
    private readonly Func<GroupNetwork, Task> _demote;
    private readonly Action<string> _progress;
    public Func<Task>? Completed { get; set; }
    public HostHandoff(string dataRoot, string clientDir, int port, Func<HandoffPending, Task> activate, Func<GroupNetwork, Task> demote, Action<string> progress)
    {
        _root = Path.GetFullPath(dataRoot); _pendingFile = Path.Combine(clientDir, "handoff-pending.json"); _port = port;
        _receiveKey = LoadReceiveKey(Path.Combine(clientDir, "handoff-receive-key.dpapi"));
        _activate = activate; _demote = demote; _progress = progress;
    }
    public static RSA LoadReceiveKey(string path)
    {
        path = Path.GetFullPath(path); SafePath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!); SafePath(path);
        if (!File.Exists(path))
        {
            using var created = RSA.Create(2048); var privateBytes = created.ExportPkcs8PrivateKey();
            var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                SafePath(temporary); using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { output.Write(ProtectedData.Protect(privateBytes, null, DataProtectionScope.CurrentUser)); output.Flush(true); }
                try { File.Move(temporary, path); } catch (IOException) when (File.Exists(path)) { SafePath(path); }
            }
            finally { CryptographicOperations.ZeroMemory(privateBytes); if (File.Exists(temporary)) File.Delete(temporary); }
        }
        if (new FileInfo(path).Length is < 1 or > 8192) throw new InvalidDataException("主机移交接收密钥无效。");
        var bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser); var rsa = RSA.Create();
        try { rsa.ImportPkcs8PrivateKey(bytes, out var read); if (read != bytes.Length || rsa.KeySize is < 2048 or > 4096) throw new InvalidDataException("主机移交接收密钥无效。"); return rsa; }
        catch { rsa.Dispose(); throw; }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    public static List<string> LocalUrls(int port) => NetworkInterface.GetAllNetworkInterfaces().Where(x => x.OperationalStatus == OperationalStatus.Up)
        .OrderBy(x => Regex.IsMatch(x.Description, "virtual|hyper-v|vpn|tun|tap", RegexOptions.IgnoreCase))
        .SelectMany(x => x.GetIPProperties().UnicastAddresses).Where(x => x.Address.AddressFamily == AddressFamily.InterNetwork)
        .Select(x => $"http://{x.Address}:{port}").Where(NetworkRoutes.IsPrivateHttp).Distinct().ToList();
    public async Task AdvertiseAsync(LanClient client, CancellationToken ct)
    {
        if (client.Network is null) return;
        try { await client.HandoffApiAsync<JsonElement>("api/native/capabilities", new { publicKey = Convert.ToBase64String(_receiveKey.ExportSubjectPublicKeyInfo()), version = UpdateChecker.CurrentVersion().ToString(3), receivePort = _port, lanUrls = LocalUrls(_port).Take(8) }, ct: ct); }
        catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.Conflict) { } // Existing capability remains fixed while the snapshot is frozen.
    }
    public async Task<HandoffPending?> LoadPendingAsync(CancellationToken ct)
    {
        return await LoadPendingAsync(Path.GetDirectoryName(_pendingFile)!, ct);
    }
    public static async Task<HandoffPending?> LoadPendingAsync(string clientDir, CancellationToken ct)
    {
        var path = Path.Combine(Path.GetFullPath(clientDir), "handoff-pending.json");
        SafePath(path); if (!File.Exists(path)) return null;
        if (new FileInfo(path).Length > 65536) throw new InvalidDataException("主机移交状态无效。");
        return JsonSerializer.Deserialize<HandoffPending>(await File.ReadAllTextAsync(path, ct), Json) ?? throw new InvalidDataException("主机移交状态无效。");
    }
    public static void ValidatePendingForStartup(HandoffPending pending, GroupNetwork expected, string storageRoot)
    {
        if (pending.Offer is null || pending.Offer.Generation < 1 || string.IsNullOrWhiteSpace(pending.Offer.TargetDeviceId) || pending.Offer.TargetDeviceId.Length > 128)
            throw new InvalidDataException("主机移交状态无效。");
        VerifyOffer(pending.Offer, expected);
        if (pending.Outgoing)
        {
            if (pending.Offer.Generation != expected.HostGeneration && pending.Offer.Generation != expected.HostGeneration + 1)
                throw new InvalidDataException("主机移交状态无效。");
            return;
        }
        if (pending.Offer.Generation != expected.HostGeneration && pending.Offer.Generation != expected.HostGeneration + 1)
            throw new InvalidDataException("主机移交状态无效。");
        var root = Path.GetFullPath(storageRoot); SafePath(root);
        var expectedData = Path.Combine(root, "groups", pending.Offer.GroupId + "-" + pending.Offer.Generation);
        if (!string.Equals(Path.GetFullPath(pending.DataDir), expectedData, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("移交目录越界。");
        SafePath(expectedData);
    }
    public async Task CheckIncomingAsync(LanClient client, CancellationToken ct)
    {
        if (client.Network is null || !await _gate.WaitAsync(0, ct)) return;
        try
        {
            if (await LoadPendingAsync(ct) is { } savedPending)
            {
                if (savedPending.Offer.GroupId != client.Network.GroupId) throw new InvalidDataException("设备组身份不一致。");
                if (savedPending.Outgoing) await FinishOutgoingAsync(client, savedPending, ct);
                else await FinishIncomingAsync(client, savedPending, ct);
                return;
            }
            HandoffInbox inbox;
            try { inbox = await client.HandoffApiAsync<HandoffInbox>("api/handoff/inbox", ct: ct); }
            catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.NotFound) { return; }
            if (inbox.Offer is not { State: "sealed" } offer) return;
            if (offer.TargetDeviceId != client.Session?.Device.Id || offer.TargetPublicKey != Convert.ToBase64String(_receiveKey.ExportSubjectPublicKeyInfo())) return;
            VerifyOffer(offer, client.Network);
            _progress("正在接收主机数据…");
            var source = client.ActiveUri;
            // Host migration is restricted to a proved local route. Internet continues to serve mobile clients.
            if (!NetworkRoutes.IsPrivateLan(source.AbsoluteUri) || source.Scheme != "https") throw new InvalidOperationException("主机移交需要两台电脑在同一局域网。");
            var destination = Path.Combine(_root, "groups", offer.GroupId + "-" + offer.Generation);
            SafePath(destination); if (Directory.Exists(destination)) throw new IOException("目标设备组目录已存在，请先完成上一次移交。");
            var stage = destination + ".staging-" + offer.Id;
            SafePath(stage); if (Directory.Exists(stage)) DeleteSafeTree(stage); Directory.CreateDirectory(stage);
            var bundle = Path.Combine(stage, "bundle.zip");
            var envelope = JsonSerializer.Deserialize<Envelope>(offer.EnvelopeJson, Json) ?? throw new InvalidDataException("移交密文头无效。");
            var key = _receiveKey.Decrypt(Convert.FromBase64String(envelope.WrappedKey), RSAEncryptionPadding.OaepSHA256);
            try
            {
                if (key.Length != 32) throw new InvalidDataException("移交密钥无效。");
                var prefix = Convert.FromBase64String(envelope.NoncePrefix); if (prefix.Length != 8) throw new InvalidDataException("移交 nonce 无效。");
                EnsureSpace(stage, checked(offer.TotalBytes * 2 + 128 * 1024 * 1024));
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                long received = 0;
                await using (var output = File.Create(bundle))
                {
                    for (var index = 0; index < offer.TotalChunks; index++)
                    {
                        using var chunk = new MemoryStream(); await client.HandoffDownloadAsync("api/handoff/chunks/" + index, chunk, 8 * 1024 * 1024, false, ct, source);
                        var encrypted = chunk.ToArray(); hash.AppendData(encrypted); received += encrypted.Length;
                        if (received > offer.TotalBytes) throw new InvalidDataException("移交密文超出清单。");
                        var plain = Decrypt(encrypted, key, prefix, offer, (uint)index);
                        try { await output.WriteAsync(plain, ct); } finally { CryptographicOperations.ZeroMemory(plain); }
                        _progress($"{index + 1}/{offer.TotalChunks}");
                    }
                }
                if (received != offer.TotalBytes || Convert.ToHexStringLower(hash.GetHashAndReset()) != offer.Sha256) throw new InvalidDataException("移交密文校验失败。");
                await ExtractBundleAsync(bundle, stage, offer, ct);
                if (client.Network.PublicUrl is { Length: > 0 } && envelope.CredentialCipher is not { Length: > 0 }) throw new InvalidDataException("公网通道凭据缺失，无法完整移交。");
                if (envelope.CredentialCipher is { Length: > 0 } cipher)
                {
                    var credential = Decrypt(Convert.FromBase64String(cipher), key, prefix, offer, uint.MaxValue);
                    try
                    {
                        using var document = JsonDocument.Parse(credential);
                        var config = document.RootElement.GetProperty("configuration").GetRawText();
                        var publicUrl = document.RootElement.GetProperty("configuration").GetProperty("publicUrl").GetString();
                        if (publicUrl != client.Network.PublicUrl || !NetworkRoutes.IsPublicHttps(publicUrl!)) throw new InvalidDataException("公网通道地址与设备组不一致。");
                        var token = Convert.FromBase64String(document.RootElement.GetProperty("token").GetString()!);
                        try { await File.WriteAllBytesAsync(Path.Combine(stage, "tunnel-token.dpapi"), ProtectedData.Protect(token, null, DataProtectionScope.CurrentUser), ct); }
                        finally { CryptographicOperations.ZeroMemory(token); }
                        await File.WriteAllTextAsync(Path.Combine(stage, "cloudflare.json"), config, ct);
                    }
                    finally { CryptographicOperations.ZeroMemory(credential); }
                }
                ValidatePublicConfiguration(stage, client.Network.PublicUrl);
                File.Delete(bundle);
                var pending = new HandoffPending { Offer = offer, DataDir = destination, Source = source.AbsoluteUri };
                await SavePendingAsync(pending, ct);
                Directory.Move(stage, destination);
                EnsurePortFree(offer.ReceivePort);
                await client.HandoffApiAsync<JsonElement>("api/handoff/ready", new { id = offer.Id, urls = LocalUrls(offer.ReceivePort).Take(8) }, ct: ct, control: source);
                await FinishIncomingAsync(client, pending, ct);
            }
            finally { CryptographicOperations.ZeroMemory(key); if (Directory.Exists(stage) && !File.Exists(_pendingFile)) DeleteSafeTree(stage); }
        }
        finally { _gate.Release(); }
    }
    public async Task TransferAsync(LanClient client, string targetDeviceId, string activeDataDir, CancellationToken ct)
    {
        await _gate.WaitAsync(ct); HandoffOffer? offer = null; var committed = false; string? temporary = null;
        try
        {
            if (client.Network is null || !client.ActiveUri.IsLoopback) throw new InvalidOperationException("此功能只能在服务电脑本机使用。");
            // Read the actual host, rather than silently trusting a stale route cache.
            client.UseNetwork(await client.HandoffApiAsync<GroupNetwork>("api/network", ct: ct, host: true));
            ValidatePublicConfiguration(activeDataDir, client.Network!.PublicUrl);
            _progress("正在准备主机移交…");
            offer = await client.HandoffApiAsync<HandoffOffer>("api/host/handoff/prepare", new { targetDeviceId }, true, ct);
            if (offer.GroupId != client.Network.GroupId || offer.Generation != client.Network.HostGeneration + 1 || offer.TargetDeviceId != targetDeviceId) throw new InvalidDataException("主机移交状态无效。");
            var export = await client.HandoffApiAsync<HandoffExport>("api/host/handoff/export", ct: ct, host: true);
            ValidateFiles(export.Files, export.TotalBytes);
            temporary = Path.Combine(_root, ".handoff-out-" + offer.Id); SafePath(temporary); Directory.CreateDirectory(temporary); EnsureSpace(temporary, checked(export.TotalBytes * 2 + 128 * 1024 * 1024));
            var bundle = Path.Combine(temporary, "bundle.zip");
            await BuildBundleAsync(client, bundle, export, offer, ct);
            var key = RandomNumberGenerator.GetBytes(32); var prefix = RandomNumberGenerator.GetBytes(8);
            try
            {
                using var rsa = RSA.Create(); rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(offer.TargetPublicKey), out _); if (rsa.KeySize < 2048) throw new InvalidDataException("目标公钥无效。");
                var envelope = new Envelope { WrappedKey = Convert.ToBase64String(rsa.Encrypt(key, RSAEncryptionPadding.OaepSHA256)), NoncePrefix = Convert.ToBase64String(prefix) };
                var tokenPath = Path.Combine(activeDataDir, "tunnel-token.dpapi"); var configPath = Path.Combine(activeDataDir, "cloudflare.json");
                if (client.Network.PublicUrl is not null)
                {
                    SafePath(tokenPath); SafePath(configPath);
                    if (!File.Exists(tokenPath) || !File.Exists(configPath)) throw new InvalidOperationException("公网通道凭据缺失，无法完整移交。");
                    var token = ProtectedData.Unprotect(await File.ReadAllBytesAsync(tokenPath, ct), null, DataProtectionScope.CurrentUser);
                    try
                    {
                        using var config = JsonDocument.Parse(await File.ReadAllTextAsync(configPath, ct));
                        var credentials = JsonSerializer.SerializeToUtf8Bytes(new { configuration = config.RootElement, token = Convert.ToBase64String(token) }, Json);
                        try { envelope.CredentialCipher = Convert.ToBase64String(Encrypt(credentials, key, prefix, offer, uint.MaxValue)); }
                        finally { CryptographicOperations.ZeroMemory(credentials); }
                    }
                    finally { CryptographicOperations.ZeroMemory(token); }
                }
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); long totalBytes = 0; var index = 0;
                await using var input = File.OpenRead(bundle); var buffer = new byte[ChunkPlainBytes];
                while (true)
                {
                    var read = await input.ReadAsync(buffer, ct); if (read == 0) break;
                    var encrypted = Encrypt(buffer.AsSpan(0, read), key, prefix, offer, (uint)index); hash.AppendData(encrypted); totalBytes += encrypted.Length;
                    await client.HandoffChunkAsync(index++, encrypted, ct); _progress($"{input.Position * 100 / input.Length}%");
                }
                await client.HandoffApiAsync<JsonElement>("api/host/handoff/seal", new { id = offer.Id, envelopeJson = JsonSerializer.Serialize(envelope, Json), totalChunks = index, totalBytes, sha256 = Convert.ToHexStringLower(hash.GetHashAndReset()) }, true, ct);
            }
            finally { CryptographicOperations.ZeroMemory(key); }
            var sealedOffer = await client.HandoffApiAsync<HandoffOffer>("api/host/handoff/status?id=" + offer.Id, ct: ct, host: true);
            if (sealedOffer.State is not ("offered" or "sealed" or "ready") || sealedOffer.Id != offer.Id || sealedOffer.Generation != offer.Generation || sealedOffer.TargetDeviceId != offer.TargetDeviceId) throw new InvalidDataException("主机移交状态无效。");
            VerifyOffer(sealedOffer, client.Network);
            var pending = new HandoffPending { Offer = sealedOffer, Source = client.ActiveUri.AbsoluteUri, Outgoing = true };
            await SavePendingAsync(pending, ct);
            while (true)
            {
                var state = await client.HandoffApiAsync<HandoffOffer>("api/host/handoff/status?id=" + offer.Id, ct: ct, host: true);
                if (state.State == "ready") break;
                if (state.State is "aborted" or "expired") throw new InvalidOperationException("主机移交已取消。");
                await Task.Delay(1500, ct);
            }
            _progress("正在切换服务主机…");
            await client.HandoffApiAsync<JsonElement>("api/host/handoff/commit", new { id = offer.Id }, true, ct); committed = true;
            await FinishOutgoingAsync(client, pending, ct);
        }
        catch
        {
            if (offer is not null && !committed) { try { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await client.HandoffApiAsync<JsonElement>("api/host/handoff/abort", new { id = offer.Id }, true, timeout.Token); DeletePending(); } catch { } }
            throw;
        }
        finally { if (temporary is not null && Directory.Exists(temporary)) { SafePath(temporary); Directory.Delete(temporary, true); } _gate.Release(); }
    }
    private async Task FinishIncomingAsync(LanClient client, HandoffPending pending, CancellationToken ct)
    {
        SafePath(pending.DataDir); if (!pending.DataDir.StartsWith(_root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("移交目录越界。");
        var source = new Uri(pending.Source); if (!NetworkRoutes.IsPrivateLan(source.AbsoluteUri) || source.Scheme != "https") throw new InvalidDataException("移交来源地址无效。");
        RestoreImportDirectory(_root, pending);
        ValidatePublicConfiguration(pending.DataDir, client.Network?.PublicUrl);
        while (true)
        {
            HandoffOffer state;
            try { state = await client.HandoffApiAsync<HandoffOffer>("api/handoff/status?id=" + pending.Offer.Id, ct: ct, control: source); }
            catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.NotFound) { RemoveUnusedImport(pending, client); DeletePending(); return; }
            if (state.State is "sealed" or "offered") { EnsurePortFree(pending.Offer.ReceivePort); await client.HandoffApiAsync<JsonElement>("api/handoff/ready", new { id = pending.Offer.Id, urls = LocalUrls(pending.Offer.ReceivePort).Take(8) }, ct: ct, control: source); }
            if (state.State == "committed") break;
            if (state.State is "aborted" or "expired") { RemoveUnusedImport(pending, client); DeletePending(); return; }
            await Task.Delay(1500, ct);
        }
        await _activate(pending);
        await client.HandoffApiAsync<JsonElement>("api/handoff/activated", new { id = pending.Offer.Id }, ct: ct, control: source);
        DeletePending(); _progress("主机移交完成");
        if (Completed is not null) await Completed();
    }
    private async Task FinishOutgoingAsync(LanClient client, HandoffPending pending, CancellationToken ct)
    {
        // A crash can leave the outgoing marker after the verified client role was saved.
        if (!client.ActiveUri.IsLoopback)
        {
            await client.RefreshNetworkAsync(ct);
            var network = client.Network ?? throw new InvalidDataException("设备组身份不一致。");
            VerifyOffer(pending.Offer, network);
            if (network.GroupId != pending.Offer.GroupId || network.HostGeneration != pending.Offer.Generation || network.HostDeviceId != pending.Offer.TargetDeviceId) throw new InvalidDataException("设备组身份不一致。");
            DeletePending(); _progress("主机移交完成"); return;
        }
        while (true)
        {
            HandoffOffer state;
            try { state = await client.HandoffApiAsync<HandoffOffer>("api/host/handoff/status?id=" + pending.Offer.Id, ct: ct, host: true); }
            catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.NotFound) { DeletePending(); return; }
            if (state.Activated)
            {
                var network = await client.HandoffApiAsync<GroupNetwork>("api/network", ct: ct, host: true);
                await _demote(network); DeletePending(); _progress("主机移交完成"); return;
            }
            if (state.State == "ready") { await client.HandoffApiAsync<JsonElement>("api/host/handoff/commit", new { id = pending.Offer.Id }, true, ct); }
            if (state.State is "aborted" or "expired") { DeletePending(); return; }
            await Task.Delay(1500, ct);
        }
    }
    public static void VerifyOffer(HandoffOffer offer, GroupNetwork group)
    {
        if (!Regex.IsMatch(offer.Id, "^[A-Za-z0-9_-]{16,128}$") || offer.GroupId != group.GroupId || offer.Generation < group.HostGeneration || offer.Generation > group.HostGeneration + 1 || offer.ReceivePort is < 1024 or > 65535 || offer.TotalChunks < 1 || offer.TotalChunks > 1000000 || offer.TotalBytes <= 16 || offer.TotalBytes > (long)offer.TotalChunks * 8 * 1024 * 1024 || !Regex.IsMatch(offer.Sha256, "^[a-f0-9]{64}$") || offer.EnvelopeJson.Length > 16384) throw new InvalidDataException("主机移交状态无效。");
        var envelopeHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(offer.EnvelopeJson)));
        var text = $"linchuan-handoff-v1\n{offer.Id}\n{offer.GroupId}\n{offer.Generation}\n{offer.TargetDeviceId}\n{offer.TotalChunks}\n{offer.TotalBytes}\n{offer.Sha256}\n{envelopeHash}";
        using var rsa = RSA.Create(); rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(group.PublicKey), out _);
        if (!rsa.VerifyData(Encoding.UTF8.GetBytes(text), Convert.FromBase64String(offer.Signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new InvalidDataException("移交签名校验失败。");
    }
    private static byte[] Nonce(byte[] prefix, uint index) { var nonce = new byte[12]; prefix.CopyTo(nonce, 0); System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(nonce.AsSpan(8), index); return nonce; }
    private static byte[] Aad(HandoffOffer offer, uint index) => Encoding.UTF8.GetBytes($"{offer.Id}\n{offer.GroupId}\n{offer.Generation}\n{offer.TargetDeviceId}\n{index}");
    public static byte[] Encrypt(ReadOnlySpan<byte> plain, byte[] key, byte[] prefix, HandoffOffer offer, uint index) { var result = new byte[plain.Length + 16]; using var aes = new AesGcm(key, 16); aes.Encrypt(Nonce(prefix, index), plain, result.AsSpan(16), result.AsSpan(0, 16), Aad(offer, index)); return result; }
    public static byte[] Decrypt(byte[] cipher, byte[] key, byte[] prefix, HandoffOffer offer, uint index) { if (cipher.Length < 16) throw new InvalidDataException("移交密文无效。"); var plain = new byte[cipher.Length - 16]; using var aes = new AesGcm(key, 16); aes.Decrypt(Nonce(prefix, index), cipher.AsSpan(16), cipher.AsSpan(0, 16), plain, Aad(offer, index)); return plain; }
    private static async Task BuildBundleAsync(LanClient client, string path, HandoffExport export, HandoffOffer offer, CancellationToken ct)
    {
        using var zip = new ZipArchive(File.Create(path), ZipArchiveMode.Create);
        foreach (var file in export.Files)
        {
            var entry = zip.CreateEntry(file.Path, CompressionLevel.NoCompression);
            await using var output = entry.Open(); await client.HandoffDownloadAsync("api/host/handoff/file/" + file.Index, output, file.Size, true, ct);
        }
        var manifest = zip.CreateEntry("manifest.json", CompressionLevel.NoCompression); await using var metadata = manifest.Open(); await JsonSerializer.SerializeAsync(metadata, new { offer.Id, offer.GroupId, offer.Generation, offer.TargetDeviceId, export.Files, export.TotalBytes }, Json, ct);
    }
    public static async Task ExtractBundleAsync(string bundle, string stage, HandoffOffer offer, CancellationToken ct)
    {
        using var zip = ZipFile.OpenRead(bundle); var manifest = zip.GetEntry("manifest.json") ?? throw new InvalidDataException("移交缺少清单。");
        if (manifest.Length > 16 * 1024 * 1024) throw new InvalidDataException("移交清单过大。");
        await using var input = manifest.Open(); var metadata = await JsonSerializer.DeserializeAsync<BundleManifest>(input, Json, ct) ?? throw new InvalidDataException("移交清单无效。");
        if (metadata.Id != offer.Id || metadata.GroupId != offer.GroupId || metadata.Generation != offer.Generation || metadata.TargetDeviceId != offer.TargetDeviceId) throw new InvalidDataException("移交清单身份不一致。");
        ValidateFiles(metadata.Files, metadata.TotalBytes);
        if (zip.Entries.Count != metadata.Files.Count + 1 || zip.Entries.Select(x => x.FullName).Distinct(StringComparer.OrdinalIgnoreCase).Count() != zip.Entries.Count) throw new InvalidDataException("移交包含重复或额外文件。");
        EnsureSpace(stage, checked(metadata.TotalBytes + 128 * 1024 * 1024));
        foreach (var file in metadata.Files)
        {
            var entry = zip.GetEntry(file.Path); if (entry is null || entry.Length != file.Size) throw new InvalidDataException("移交文件与清单不一致。");
            var destination = Path.Combine(stage, file.Path.Replace('/', Path.DirectorySeparatorChar)); SafePath(destination); Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); await using var source = entry.Open(); await using var output = new FileStream(destination, FileMode.CreateNew); var buffer = new byte[128 * 1024]; long count = 0;
            while (true) { var read = await source.ReadAsync(buffer, ct); if (read == 0) break; count += read; if (count > file.Size) throw new InvalidDataException("移交文件超出大小限制。"); hash.AppendData(buffer.AsSpan(0, read)); await output.WriteAsync(buffer.AsMemory(0, read), ct); }
            if (count != file.Size || Convert.ToHexStringLower(hash.GetHashAndReset()) != file.Sha256) throw new InvalidDataException("移交文件校验失败。");
        }
    }
    private static void ValidateFiles(List<HandoffFile> files, long totalBytes)
    {
        if (files.Count is < 1 or > 100000 || files.Count(x => x.Path == "linchuan.sqlite") != 1 || files.Select(x => x.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Count) throw new InvalidDataException("移交文件清单无效。");
        long sum = 0;
        foreach (var file in files) { if (file.Path != "linchuan.sqlite" && !Regex.IsMatch(file.Path, "^uploads/[A-Za-z0-9_-]{16,128}$")) throw new InvalidDataException("移交文件路径无效。"); if (file.Size < 0 || !Regex.IsMatch(file.Sha256, "^[a-f0-9]{64}$")) throw new InvalidDataException("移交文件清单无效。"); sum = checked(sum + file.Size); }
        if (sum != totalBytes) throw new InvalidDataException("移交文件总大小不一致。");
    }
    public static void SafePath(string path)
    {
        for (var current = Path.GetFullPath(path); !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("移交路径不能包含 reparse point。");
    }
    public static void ValidatePublicConfiguration(string dataDir, string? expectedPublicUrl)
    {
        var configPath = Path.Combine(dataDir, "cloudflare.json"); var tokenPath = Path.Combine(dataDir, "tunnel-token.dpapi"); SafePath(configPath); SafePath(tokenPath);
        var configured = BackendHost.ReadPublicUrl(dataDir);
        if (!string.Equals(configured, expectedPublicUrl, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("公网通道地址与设备组不一致。");
        if (expectedPublicUrl is not { Length: > 0 }) return;
        if (!NetworkRoutes.IsPublicHttps(expectedPublicUrl) || !File.Exists(configPath) || !File.Exists(tokenPath)) throw new InvalidDataException("公网通道凭据缺失，无法完整移交。");
        if (new FileInfo(tokenPath).Length is < 1 or > 16384) throw new InvalidDataException("公网通道凭据缺失，无法完整移交。");
        var token = ProtectedData.Unprotect(File.ReadAllBytes(tokenPath), null, DataProtectionScope.CurrentUser);
        try { if (token.Length == 0) throw new InvalidDataException("公网通道凭据缺失，无法完整移交。"); }
        finally { CryptographicOperations.ZeroMemory(token); }
    }
    public static void RestoreImportDirectory(string root, HandoffPending pending)
    {
        if (!Guid.TryParse(pending.Offer.GroupId, out _) || pending.Offer.Generation < 1 || !Regex.IsMatch(pending.Offer.Id, "^[A-Za-z0-9_-]{16,128}$")) throw new InvalidDataException("主机移交状态无效。");
        var expected = Path.GetFullPath(Path.Combine(root, "groups", pending.Offer.GroupId + "-" + pending.Offer.Generation));
        if (!string.Equals(expected, Path.GetFullPath(pending.DataDir), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("移交目录越界。");
        SafePath(expected);
        var stage = expected + ".staging-" + pending.Offer.Id; SafePath(stage);
        if (Directory.Exists(expected)) { AssertSafeTree(expected); if (Directory.Exists(stage)) DeleteSafeTree(stage); return; }
        if (!Directory.Exists(stage)) throw new IOException("已接收的主机数据目录不存在。");
        AssertSafeTree(stage); Directory.Move(stage, expected);
    }
    private static void AssertSafeTree(string path)
    {
        SafePath(path);
        foreach (var child in Directory.EnumerateFileSystemEntries(path)) { SafePath(child); if (Directory.Exists(child)) AssertSafeTree(child); }
    }
    private static void DeleteSafeTree(string path) { AssertSafeTree(path); Directory.Delete(path, true); }
    private static void EnsureSpace(string path, long bytes) { if (new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace < bytes) throw new IOException("磁盘空间不足，无法完整移交。"); }
    private static void EnsurePortFree(int port) { foreach (var candidate in new[] { port, port == 65535 ? port - 1 : port + 1 }) { var listener = new TcpListener(IPAddress.Any, candidate); try { listener.Start(); } finally { listener.Stop(); } } }
    private async Task SavePendingAsync(HandoffPending pending, CancellationToken ct) { SafePath(_pendingFile); var temp = _pendingFile + ".tmp-" + Guid.NewGuid().ToString("N"); try { SafePath(temp); await using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16384, FileOptions.Asynchronous)) { await JsonSerializer.SerializeAsync(output, pending, Json, ct); await output.FlushAsync(ct); output.Flush(true); } File.Move(temp, _pendingFile, true); } finally { if (File.Exists(temp)) File.Delete(temp); } }
    private void DeletePending() { SafePath(_pendingFile); if (File.Exists(_pendingFile)) File.Delete(_pendingFile); }
    private void RemoveUnusedImport(HandoffPending pending, LanClient client)
    {
        // A committed, active group is never removed as part of cancellation recovery.
        if (client.Network?.HostGeneration >= pending.Offer.Generation) return;
        var expected = Path.GetFullPath(Path.Combine(_root, "groups", pending.Offer.GroupId + "-" + pending.Offer.Generation));
        if (!string.Equals(expected, Path.GetFullPath(pending.DataDir), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("移交目录越界。");
        SafePath(expected); if (Directory.Exists(expected)) DeleteSafeTree(expected);
        var stage = expected + ".staging-" + pending.Offer.Id; if (Directory.Exists(stage)) DeleteSafeTree(stage);
    }
    public async ValueTask DisposeAsync() { await _gate.WaitAsync(); try { _receiveKey.Dispose(); } finally { _gate.Release(); } }
    private sealed class Envelope { public string WrappedKey { get; set; } = ""; public string NoncePrefix { get; set; } = ""; public string? CredentialCipher { get; set; } }
    private sealed class BundleManifest { public string Id { get; set; } = ""; public string GroupId { get; set; } = ""; public long Generation { get; set; } public string TargetDeviceId { get; set; } = ""; public List<HandoffFile> Files { get; set; } = []; public long TotalBytes { get; set; } }
}
