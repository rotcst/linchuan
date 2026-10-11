using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Linchuan.Desktop.Core;

public sealed class LanClient : IAsyncDisposable
{
    private const int ChunkBytes = 8 * 1024 * 1024;
    private const int MaxSocketMessageBytes = 4 * 1024 * 1024;
    private const long MaxLocalPreviewBytes = 64 * 1024 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _http;
    private readonly Uri _baseUri;
    private readonly SemaphoreSlim _socketGate = new(1, 1);
    private ClientWebSocket? _socket;
    private CancellationTokenSource? _socketCts;
    private readonly CancellationTokenSource _reconnectCts = new();
    private readonly CancellationTokenSource _lifetimeCts = new();
    private int _disposed;
    private SessionInfo? _session;

    public LanClient(Uri baseUri)
    {
        _baseUri = new Uri(baseUri.AbsoluteUri.TrimEnd('/') + "/", UriKind.Absolute);
        _http = new HttpClient(new HttpClientHandler { UseCookies = true, AllowAutoRedirect = false })
        {
            BaseAddress = _baseUri,
            Timeout = TimeSpan.FromMinutes(5),
        };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Linchuan", UpdateChecker.CurrentVersion().ToString(3)));
    }

    public SessionInfo? Session => _session;
    public IReadOnlyList<Device> Devices => _session?.Devices ?? [];
    public event Action<IReadOnlyList<Device>>? PresenceChanged;
    public event Action<ChatMessage>? MessageReceived;
    public event Action<string>? MessageHidden;
    public event Action<string>? ConnectionChanged;

    public Task<ServerInfo> InfoAsync(CancellationToken ct = default) =>
        SendAsync<ServerInfo>(HttpMethod.Get, "api/info", null, false, ct);

    public Task<HostInfo> HostAsync(CancellationToken ct = default) =>
        SendAsync<HostInfo>(HttpMethod.Get, "api/host", null, false, ct, hostOnly: true);

    public async Task<IReadOnlyList<Device>> HostDevicesAsync(CancellationToken ct = default)
    {
        var result = await SendAsync<DeviceList>(HttpMethod.Get, "api/host/devices", null, false, ct, hostOnly: true);
        return result.Devices;
    }

    public async Task<SessionInfo> ClaimDesktopAsync(string deviceId, string code, CancellationToken ct = default)
    {
        var body = JsonSerializer.Serialize(new { deviceId, code }, JsonOptions);
        var session = await SendAsync<SessionInfo>(HttpMethod.Post, "api/host/desktop-session", body, false, ct, hostOnly: true);
        _session = session;
        ConnectionChanged?.Invoke("connected");
        return session;
    }

    public async Task<SessionInfo> JoinAsync(string code, string name, string deviceId, CancellationToken ct = default)
    {
        var body = JsonSerializer.Serialize(new { code, name, deviceId, type = "computer" }, JsonOptions);
        var session = await SendAsync<SessionInfo>(HttpMethod.Post, "api/join", body, false, ct);
        _session = session;
        ConnectionChanged?.Invoke("connected");
        return session;
    }

    public async Task<SessionInfo?> RestoreAsync(string token, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        _session = new SessionInfo { Token = token };
        try
        {
            var restored = await SendAsync<SessionInfo>(HttpMethod.Get, "api/session", null, true, ct);
            restored.Token = token;
            _session = restored;
            ConnectionChanged?.Invoke("connected");
            return restored;
        }
        catch (HttpRequestException ex) when (ex.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            _session = null;
            return null;
        }
        catch
        {
            _session = null;
            throw;
        }
    }

    public async Task<HistoryPage> HistoryAsync(string to = "all", string? beforeId = null, long? before = null, CancellationToken ct = default)
    {
        var query = $"api/messages?to={Uri.EscapeDataString(to)}";
        if (before.HasValue) query += $"&before={before.Value}";
        if (!string.IsNullOrEmpty(beforeId)) query += $"&beforeId={Uri.EscapeDataString(beforeId)}";
        return await SendAsync<HistoryPage>(HttpMethod.Get, query, null, true, ct);
    }

    public async Task<ChatMessage> SendTextAsync(string to, string text, CancellationToken ct = default)
    {
        var body = JsonSerializer.Serialize(new { to, text, clientId = Guid.NewGuid().ToString("N") }, JsonOptions);
        return await SendAsync<ChatMessage>(HttpMethod.Post, "api/messages", body, true, ct);
    }

    public async Task HideAsync(string id, CancellationToken ct = default)
    {
        using var response = await SendResponseAsync(HttpMethod.Delete, $"api/messages/{Uri.EscapeDataString(id)}", null, true, ct);
    }

    public async Task UpdateDeviceAsync(string name, DeviceType type, CancellationToken ct = default)
    {
        var body = JsonSerializer.Serialize(new { name, type = TypeName(type) }, JsonOptions);
        var result = await SendAsync<DeviceEnvelope>(HttpMethod.Put, "api/device", body, true, ct);
        if (_session is not null) _session.Device = result.Device;
        PresenceChanged?.Invoke(Devices);
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        using var response = await SendResponseAsync(HttpMethod.Post, "api/logout", null, true, ct);
        await DisconnectSocketAsync();
        _session = null;
        ConnectionChanged?.Invoke("disconnected");
    }

    public Task<HostInfo> RefreshCodeAsync(CancellationToken ct = default) =>
        SendAsync<HostInfo>(HttpMethod.Post, "api/host/code", null, false, ct, hostOnly: true);

    public async Task StopHostAsync(CancellationToken ct = default)
    {
        using var response = await SendResponseAsync(HttpMethod.Post, "api/host/stop", null, false, ct, hostOnly: true);
    }

    public async Task ConnectSocketAsync(CancellationToken ct = default)
    {
        ThrowIfDisposed();
        if (_session is null) throw new InvalidOperationException("尚未建立会话。");
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _lifetimeCts.Token);
        await _socketGate.WaitAsync(linked.Token);
        try
        {
            ThrowIfDisposed();
            await DisconnectSocketAsync();
            var socket = new ClientWebSocket();
            socket.Options.SetRequestHeader("User-Agent", $"Linchuan/{UpdateChecker.CurrentVersion().ToString(3)}");
            socket.Options.SetRequestHeader("Origin", _baseUri.GetLeftPart(UriPartial.Authority));
            socket.Options.SetRequestHeader("Cookie", $"linchuan_session={_session.Token}");
            var builder = new UriBuilder(_baseUri) { Scheme = _baseUri.Scheme == "https" ? "wss" : "ws", Path = "ws" };
            await socket.ConnectAsync(builder.Uri, linked.Token);
            if (Volatile.Read(ref _disposed) != 0) { socket.Abort(); socket.Dispose(); throw new ObjectDisposedException(nameof(LanClient)); }
            _socket = socket;
            _socketCts = new CancellationTokenSource();
            ConnectionChanged?.Invoke("connected");
            _ = ReceiveSocketAsync(socket, _socketCts.Token);
        }
        finally { _socketGate.Release(); }
    }

    public async Task UploadAsync(string path, string to, IProgress<UploadProgress>? progress = null, CancellationToken ct = default)
    {
        if (_session is null) throw new InvalidOperationException("尚未建立会话。");
        var file = new FileInfo(path);
        if (!file.Exists) throw new FileNotFoundException("找不到上传文件。", path);
        var clientId = Guid.NewGuid().ToString("N");
        var metadata = JsonSerializer.Serialize(new { name = file.Name, size = file.Length, mime = MimeFor(file.Name), to, clientId }, JsonOptions);
        TransferStart start = await SendAsync<TransferStart>(HttpMethod.Post, "api/transfers", metadata, true, ct);
        if (!string.IsNullOrEmpty(start.Message?.Id)) return;
        var completed = false;
        try
        {
            var offset = start.Offset;
            var failures = 0;
            while (offset < file.Length)
            {
                ct.ThrowIfCancellationRequested();
                var length = (int)Math.Min(start.ChunkBytes > 0 ? start.ChunkBytes : ChunkBytes, file.Length - offset);
                try
                {
                    await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
                    input.Position = offset;
                    await using var limited = new LimitedReadStream(input, length);
                    using var content = new StreamContent(limited) { Headers = { ContentType = new MediaTypeHeaderValue("application/octet-stream"), ContentLength = length } };
                    using var response = await SendResponseAsync(HttpMethod.Put, $"api/transfers/{Uri.EscapeDataString(start.Id)}?offset={offset}", content, true, ct);
                    var result = await ReadJsonAsync<TransferState>(response, ct);
                    if (result.Offset <= offset || result.Offset > file.Length) throw new InvalidDataException("服务器返回的上传进度无效。");
                    offset = result.Offset;
                    failures = 0;
                    progress?.Report(new UploadProgress { UploadedBytes = offset, TotalBytes = file.Length });
                }
                catch when (!ct.IsCancellationRequested && ++failures <= 3)
                {
                    var state = await SendAsync<TransferState>(HttpMethod.Get, $"api/transfers/{Uri.EscapeDataString(start.Id)}", null, true, ct);
                    if (state.Offset < offset || state.Offset > file.Length) throw;
                    offset = state.Offset;
                    await Task.Delay(TimeSpan.FromMilliseconds(failures * 700), ct);
                }
            }
            await SendAsync<ChatMessage>(HttpMethod.Post, $"api/transfers/{Uri.EscapeDataString(start.Id)}/complete", null, true, ct);
            progress?.Report(new UploadProgress { UploadedBytes = file.Length, TotalBytes = file.Length });
            completed = true;
        }
        finally
        {
            if (!completed)
                try { using var _ = await SendResponseAsync(HttpMethod.Delete, $"api/transfers/{Uri.EscapeDataString(start.Id)}", null, true, CancellationToken.None); } catch { }
        }
    }

    public async Task DownloadAsync(string fileId, string target, CancellationToken ct = default)
    {
        using var response = await SendResponseAsync(HttpMethod.Get, $"api/files/{Uri.EscapeDataString(fileId)}", null, true, ct, responseHeadersOnly: true);
        var parent = Path.GetDirectoryName(Path.GetFullPath(target));
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        var temp = target + ".part-" + Guid.NewGuid().ToString("N");
        await using var source = await response.Content.ReadAsStreamAsync(ct);
        try
        {
            await using (var destination = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan))
                await source.CopyToAsync(destination, 128 * 1024, ct);
            File.Move(temp, target, true);
        }
        finally { try { if (File.Exists(temp)) File.Delete(temp); } catch { } }
    }

    public async Task<byte[]> GetBytesAsync(string relative, long maxBytes = MaxLocalPreviewBytes, CancellationToken ct = default)
    {
        if (maxBytes <= 0 || maxBytes > MaxLocalPreviewBytes) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        relative = relative.TrimStart('/');
        if (relative.Contains("..", StringComparison.Ordinal) || relative.StartsWith("/", StringComparison.Ordinal) || Uri.TryCreate(relative, UriKind.Absolute, out _)) throw new ArgumentException("relative 必须是安全相对路径。", nameof(relative));
        using var response = await SendResponseAsync(HttpMethod.Get, relative, null, true, ct, responseHeadersOnly: true);
        if (response.Content.Headers.ContentLength > maxBytes) throw new InvalidDataException("响应超过大小限制。");
        await using var source = await response.Content.ReadAsStreamAsync(ct);
        await using var output = new MemoryStream();
        var buffer = new byte[128 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(buffer, ct); if (read == 0) break;
            if (output.Length + read > maxBytes) throw new InvalidDataException("响应超过大小限制。");
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        return output.ToArray();
    }

    public static async Task<byte[]> ReadImageAsync(string path, CancellationToken ct = default)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("找不到图片。", path);
        if (info.Length > MaxLocalPreviewBytes) throw new InvalidDataException("图片超过本地预览大小限制。");
        return await File.ReadAllBytesAsync(path, ct);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _reconnectCts.Cancel();
        _lifetimeCts.Cancel();
        await DisconnectSocketAsync();
        _session = null;
        _http.Dispose();
    }

    private async Task ReceiveSocketAsync(ClientWebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, ct);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    if (message.Length + result.Count > MaxSocketMessageBytes) throw new InvalidDataException("WebSocket 消息过大。");
                    await message.WriteAsync(buffer.AsMemory(0, result.Count), ct);
                } while (!result.EndOfMessage);
                using var document = JsonDocument.Parse(message.ToArray());
                var root = document.RootElement;
                var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : null;
                if ((type == "ready" || type == "presence") && root.TryGetProperty("devices", out var devices))
                {
                    if (_session is not null) _session.Devices = JsonSerializer.Deserialize<List<Device>>(devices, JsonOptions) ?? [];
                    PresenceChanged?.Invoke(Devices);
                }
                else if (type == "message" && root.TryGetProperty("message", out var messageElement))
                    MessageReceived?.Invoke(JsonSerializer.Deserialize<ChatMessage>(messageElement, JsonOptions) ?? new());
                else if (type == "message-deleted" && root.TryGetProperty("id", out var id))
                    MessageHidden?.Invoke(id.GetString() ?? string.Empty);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (WebSocketException) { }
        catch (InvalidDataException) { }
        catch (JsonException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            if (Volatile.Read(ref _disposed) == 0)
            {
                ConnectionChanged?.Invoke("reconnecting");
                if (!ct.IsCancellationRequested && ReferenceEquals(socket, _socket)) _ = ReconnectAsync(_reconnectCts.Token);
            }
        }
    }

    private async Task ReconnectAsync(CancellationToken ct)
    {
        for (var attempt = 0; !ct.IsCancellationRequested; attempt++)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, Math.Min(attempt, 5)))), ct); await ConnectSocketAsync(ct); return; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (ObjectDisposedException) when (Volatile.Read(ref _disposed) != 0) { return; }
            catch (Exception) { ConnectionChanged?.Invoke("reconnecting"); }
        }
    }

    private async Task DisconnectSocketAsync()
    {
        var socket = Interlocked.Exchange(ref _socket, null);
        var cts = Interlocked.Exchange(ref _socketCts, null);
        cts?.Cancel();
        if (socket is not null)
        {
            try
            {
                if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    // Some ClientWebSocket implementations do not complete CloseAsync
                    // promptly when the peer is already gone. Keep shutdown bounded;
                    // Abort in finally below is the authoritative teardown path.
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "关闭", timeout.Token).WaitAsync(TimeSpan.FromSeconds(2));
                }
            }
            catch { }
            finally
            {
                try { socket.Abort(); } catch { }
                socket.Dispose();
            }
        }
        cts?.Dispose();
    }

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref _disposed) != 0) throw new ObjectDisposedException(nameof(LanClient));
    }

    private async Task<T> SendAsync<T>(HttpMethod method, string path, string? json, bool auth, CancellationToken ct, bool hostOnly = false)
    {
        using var response = await SendResponseAsync(method, path, json is null ? null : new StringContent(json, Encoding.UTF8, "application/json"), auth, ct, hostOnly: hostOnly);
        return await ReadJsonAsync<T>(response, ct);
    }

    private async Task<HttpResponseMessage> SendResponseAsync(HttpMethod method, string path, HttpContent? content, bool auth, CancellationToken ct, bool hostOnly = false, bool responseHeadersOnly = false)
    {
        using var request = new HttpRequestMessage(method, path) { Content = content };
        if (auth && !string.IsNullOrEmpty(_session?.Token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _session.Token);
        if (hostOnly) request.Headers.TryAddWithoutValidation("X-Linchuan-Host", "1");
        var response = await _http.SendAsync(request, responseHeadersOnly ? HttpCompletionOption.ResponseHeadersRead : HttpCompletionOption.ResponseContentRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync(ct);
            var message = ExtractApiError(detail);
            response.Dispose();
            throw new HttpRequestException(string.IsNullOrWhiteSpace(message) ? "服务请求失败。" : message, null, response.StatusCode);
        }
        return response;
    }

    private static async Task<T> ReadJsonAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        var value = await response.Content.ReadFromJsonAsync<T>(JsonOptions, ct);
        return value ?? throw new InvalidDataException("服务返回的数据为空。");
    }

    private static string TypeName(DeviceType type) => type switch { DeviceType.Phone => "phone", DeviceType.Tablet => "tablet", _ => "computer" };
    private static string ExtractApiError(string detail)
    {
        try
        {
            using var json = JsonDocument.Parse(detail);
            if (json.RootElement.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String) return error.GetString() ?? string.Empty;
        }
        catch (JsonException) { }
        return string.Empty;
    }
    private static string MimeFor(string name) => Path.GetExtension(name).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        ".mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    };
    private sealed class DeviceEnvelope { public Device Device { get; set; } = new(); }
    private sealed class TransferStart { public string Id { get; set; } = string.Empty; public long Offset { get; set; } public int ChunkBytes { get; set; } public ChatMessage? Message { get; set; } }
    private sealed class TransferState { public long Offset { get; set; } }

    private sealed class LimitedReadStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _length;
        private long _remaining;
        public LimitedReadStream(Stream inner, long remaining) { _inner = inner; _length = remaining; _remaining = remaining; }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => _length; public override long Position { get => _length - _remaining; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer) { var count = (int)Math.Min(buffer.Length, _remaining); if (count == 0) return 0; var read = _inner.Read(buffer[..count]); _remaining -= read; return read; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) { var count = (int)Math.Min(buffer.Length, _remaining); if (count == 0) return 0; var read = await _inner.ReadAsync(buffer[..count], ct); _remaining -= read; return read; }
        public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken ct) => Task.CompletedTask;
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
