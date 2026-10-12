using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace Linchuan.Desktop.Core;

public sealed class GroupNetwork
{
    public int Protocol { get; set; }
    public string GroupId { get; set; } = "";
    public string PublicKey { get; set; } = "";
    public long HostGeneration { get; set; }
    public string? HostDeviceId { get; set; }
    public string? Internet { get; set; }
    public List<string> LanUrls { get; set; } = [];
    public string? PublicUrl { get; set; }
}

/// <summary>Probe a pinned group without exposing the session to an unknown endpoint.</summary>
public sealed class NetworkRoutes : IDisposable
{
    private readonly HttpClient _probe;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Uri _initial;
    public NetworkRoutes(Uri initial)
    {
        _initial = Origin(initial); Active = _initial;
        _probe = new HttpClient(new HttpClientHandler { UseCookies = false, UseProxy = false, AllowAutoRedirect = false, ServerCertificateCustomValidationCallback = (request, certificate, _, errors) => ValidateCertificate(request.RequestUri!, certificate, errors, Group) }) { Timeout = TimeSpan.FromSeconds(2) };
    }
    public GroupNetwork? Group { get; private set; }
    public Uri Active { get; private set; }
    public event Action<Uri>? Changed;
    public void Pin(GroupNetwork group)
    {
        if (group.Protocol != 1 || !Guid.TryParse(group.GroupId, out _) || group.HostGeneration < 1 || group.PublicKey.Length > 4096 || group.LanUrls.Count > 8) throw new InvalidDataException("设备组信息无效。");
        using var rsa = RSA.Create(); rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(group.PublicKey), out var read);
        if (read != Convert.FromBase64String(group.PublicKey).Length || rsa.KeySize < 2048) throw new InvalidDataException("设备组公钥无效。");
        if (Group is not null && (Group.GroupId != group.GroupId || Group.PublicKey != group.PublicKey || group.HostGeneration < Group.HostGeneration)) throw new InvalidDataException("设备组身份不一致。");
        Group = group;
    }
    public async Task<Uri> SelectAsync(CancellationToken ct = default)
    {
        if (Group is null) return Active;
        await _gate.WaitAsync(ct);
        try
        {
            var group = Group;
            // A loopback entry is useful only after a signed response proves it belongs to this group.
            var local = (_initial.Scheme == "http" && _initial.IsLoopback ? new[] { _initial } : Array.Empty<Uri>())
                .Concat(group.LanUrls.Where(x => IsPrivateLan(x) && new Uri(x).Scheme == "https").Take(8).Select(x => Origin(new Uri(x))))
                .DistinctBy(x => x.AbsoluteUri).ToArray();
            var results = await Task.WhenAll(local.Select(x => ProbeAsync(x, group, ct)));
            var selected = results.FirstOrDefault(x => x is not null);
            if (selected is null && group.PublicUrl is { Length: > 0 } value && IsPublicHttps(value)) selected = await ProbeAsync(Origin(new Uri(value)), group, ct);
            if (selected is null) throw new HttpRequestException("当前设备组没有可用连接，正在重试。");
            if (selected != Active) { Active = selected; Changed?.Invoke(selected); }
            return Active;
        }
        finally { _gate.Release(); }
    }
    public async Task<Uri?> ProbeAsync(Uri address, GroupNetwork group, CancellationToken ct = default)
    {
        try
        {
            var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromMilliseconds(1200));
            using var response = await _probe.GetAsync(new Uri(address, "api/network/probe?nonce=" + nonce), HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > 4096) return null;
            await using var input = await response.Content.ReadAsStreamAsync(timeout.Token); using var buffer = new MemoryStream(); var bytes = new byte[1024];
            while (true) { var count = await input.ReadAsync(bytes, timeout.Token); if (count == 0) break; if (buffer.Length + count > 4096) return null; buffer.Write(bytes, 0, count); }
            var result = System.Text.Json.JsonSerializer.Deserialize<Probe>(buffer.ToArray(), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
            if (result is null || result.Protocol != 1 || result.Nonce != nonce || result.GroupId != group.GroupId) return null;
            using var rsa = RSA.Create(); rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(group.PublicKey), out _);
            return rsa.VerifyData(Encoding.UTF8.GetBytes($"linchuan-network-v1\n{group.GroupId}\n{nonce}"), Convert.FromBase64String(result.Signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1) ? Origin(address) : null;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return null; }
        catch (Exception ex) when (ex is HttpRequestException or System.Text.Json.JsonException or FormatException or CryptographicException or InvalidDataException) { return null; }
    }
    public static bool IsPrivateHttp(string value)
    {
        return IsPrivateLan(value) && new Uri(value).Scheme == "http";
    }
    public static bool IsPrivateLan(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0 || uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0 || !IPAddress.TryParse(uri.Host, out var ip)) return false;
        var b = ip.GetAddressBytes();
        return b.Length == 4 && (b[0] == 10 || b[0] == 192 && b[1] == 168 || b[0] == 172 && b[1] is >= 16 and <= 31);
    }
    public static bool IsPublicHttps(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.UserInfo.Length == 0 && uri.AbsolutePath == "/" && uri.Query.Length == 0 && uri.Fragment.Length == 0;
    public static bool ValidateCertificate(Uri address, X509Certificate2? certificate, SslPolicyErrors errors, GroupNetwork? group)
    {
        if (!IsPrivateLan(address.GetLeftPart(UriPartial.Authority))) return errors == SslPolicyErrors.None;
        if (group is null) return errors == SslPolicyErrors.None;
        if (certificate is null || address.Scheme != "https" || certificate.NotBefore.ToUniversalTime() > DateTime.UtcNow || certificate.NotAfter.ToUniversalTime() < DateTime.UtcNow) return false;
        try { using var rsa = certificate.GetRSAPublicKey(); return rsa is not null && CryptographicOperations.FixedTimeEquals(rsa.ExportSubjectPublicKeyInfo(), Convert.FromBase64String(group.PublicKey)); }
        catch (CryptographicException) { return false; }
        catch (FormatException) { return false; }
    }
    private static Uri Origin(Uri value) => new(value.GetLeftPart(UriPartial.Authority) + "/");
    public void Dispose() => _probe.Dispose();
    private sealed class Probe { public int Protocol { get; set; } public string GroupId { get; set; } = ""; public string Nonce { get; set; } = ""; public string Signature { get; set; } = ""; }
}
