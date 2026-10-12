using System.Net.Http.Headers;
using System.Text.Json;

namespace Linchuan.Desktop.Core;

public sealed partial class LanClient
{
    public async Task<SessionInfo> RestoreHandoffControlAsync(string token, Uri address, CancellationToken ct)
    {
        if (Network is null || !(address.IsLoopback && address.Scheme == "http") && !(NetworkRoutes.IsPrivateLan(address.AbsoluteUri) && address.Scheme == "https")) throw new InvalidDataException("移交来源地址无效。");
        _session = new SessionInfo { Token = token };
        try { var restored = await HandoffApiAsync<SessionInfo>("api/session", ct: ct, control: address); restored.Token = token; _session = restored; return restored; }
        catch { _session = null; throw; }
    }
    public Task<T> HandoffApiAsync<T>(string path, object? body = null, bool host = false, CancellationToken ct = default, Uri? control = null) => HandoffJsonAsync<T>(body is null ? HttpMethod.Get : HttpMethod.Post, path, body, host, ct, control);
    private async Task<T> HandoffJsonAsync<T>(HttpMethod method, string path, object? body, bool host, CancellationToken ct, Uri? control)
    {
        using var content = body is null ? null : new StringContent(JsonSerializer.Serialize(body, JsonOptions), System.Text.Encoding.UTF8, "application/json");
        using var response = await HandoffRequestAsync(method, path, content, host, ct, control);
        if (response.StatusCode == System.Net.HttpStatusCode.NoContent && typeof(T) == typeof(JsonElement)) return (T)(object)JsonSerializer.SerializeToElement(new { });
        return await ReadJsonAsync<T>(response, ct);
    }
    public async Task HandoffChunkAsync(int index, byte[] bytes, CancellationToken ct)
    {
        using var content = new ByteArrayContent(bytes); content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var response = await HandoffRequestAsync(HttpMethod.Put, "api/host/handoff/chunks/" + index, content, true, ct);
    }
    public async Task HandoffDownloadAsync(string path, Stream destination, long maxBytes, bool host, CancellationToken ct, Uri? control = null)
    {
        using var response = await HandoffRequestAsync(HttpMethod.Get, path, null, host, ct, control);
        if (response.Content.Headers.ContentLength > maxBytes) throw new InvalidDataException("移交文件超过清单限制。");
        await using var source = await response.Content.ReadAsStreamAsync(ct); var buffer = new byte[128 * 1024]; long count = 0;
        while (true) { var read = await source.ReadAsync(buffer, ct); if (read == 0) break; count += read; if (count > maxBytes) throw new InvalidDataException("移交文件超过清单限制。"); await destination.WriteAsync(buffer.AsMemory(0, read), ct); }
    }
    private async Task<HttpResponseMessage> HandoffRequestAsync(HttpMethod method, string path, HttpContent? content, bool host, CancellationToken ct, Uri? control = null)
    {
        using var request = new HttpRequestMessage(method, new Uri(control ?? (host ? _baseUri : ActiveUri), path)) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _session?.Token ?? throw new InvalidOperationException("尚未建立会话。"));
        if (host) request.Headers.TryAddWithoutValidation("X-Linchuan-Host", "1");
        var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode) { var detail = await response.Content.ReadAsStringAsync(ct); var status = response.StatusCode; response.Dispose(); throw new HttpRequestException(ExtractApiError(detail), null, status); }
        return response;
    }
}

public sealed class HandoffOffer
{
    public string Id { get; set; } = "";
    public string GroupId { get; set; } = "";
    public long Generation { get; set; }
    public string TargetDeviceId { get; set; } = "";
    public string TargetPublicKey { get; set; } = "";
    public int ReceivePort { get; set; }
    public string State { get; set; } = "";
    public string EnvelopeJson { get; set; } = "";
    public int TotalChunks { get; set; }
    public long TotalBytes { get; set; }
    public string Sha256 { get; set; } = "";
    public string Signature { get; set; } = "";
    public bool Activated { get; set; }
    public List<string> Urls { get; set; } = [];
}
public sealed class HandoffFile { public int Index { get; set; } public string Path { get; set; } = ""; public long Size { get; set; } public string Sha256 { get; set; } = ""; }
public sealed class HandoffExport { public List<HandoffFile> Files { get; set; } = []; public long TotalBytes { get; set; } }
public sealed class HandoffInbox { public HandoffOffer? Offer { get; set; } }
