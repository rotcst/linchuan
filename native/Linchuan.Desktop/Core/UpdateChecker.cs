using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Linchuan.Desktop.Core;

public enum UpdateStatus { NoUpdate, UpdateAvailable, PreviewAhead, NoRelease, NetworkError }

public sealed record UpdateResult(UpdateStatus Status, Version CurrentVersion, Version? LatestVersion = null, Uri? ReleaseUrl = null, string? Error = null);

public sealed class UpdateChecker : IDisposable
{
    public const string Repository = "rotcst/linchuan";
    private static readonly Uri LatestUri = new("https://api.github.com/repos/rotcst/linchuan/releases/latest");
    private readonly HttpClient _http;

    public UpdateChecker(HttpMessageHandler? handler = null, TimeSpan? timeout = null)
    {
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.Timeout = timeout ?? TimeSpan.FromSeconds(10);
        _http.DefaultRequestHeaders.UserAgent.Clear();
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Linchuan", CurrentVersion().ToString(3)));
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
    }

    public static Version CurrentVersion()
    {
        var version = typeof(UpdateChecker).Assembly.GetName().Version ?? new Version(1, 0, 0);
        return new Version(version.Major, version.Minor, Math.Max(0, version.Build));
    }

    public async Task<UpdateResult> CheckAsync(CancellationToken ct = default)
    {
        var current = CurrentVersion();
        try
        {
            using var response = await _http.GetAsync(LatestUri, ct);
            if (response.StatusCode == HttpStatusCode.NotFound) return new(UpdateStatus.NoRelease, current);
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = document.RootElement;
            if (root.TryGetProperty("draft", out var draft) && draft.GetBoolean()) return new(UpdateStatus.NoRelease, current);
            if (root.TryGetProperty("prerelease", out var prerelease) && prerelease.GetBoolean()) return new(UpdateStatus.NoRelease, current);
            var tag = root.TryGetProperty("tag_name", out var tagElement) ? tagElement.GetString() : null;
            var latest = ParseStableVersion(tag);
            var release = root.TryGetProperty("html_url", out var urlElement) ? urlElement.GetString() : null;
            if (latest is null || !TryReleaseUrl(release, out var releaseUri)) return new(UpdateStatus.NoRelease, current);
            var status = latest > current ? UpdateStatus.UpdateAvailable : latest < current ? UpdateStatus.PreviewAhead : UpdateStatus.NoUpdate;
            return new(status, current, latest, releaseUri);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new(UpdateStatus.NetworkError, current, Error: "timeout"); }
        catch (HttpRequestException ex) { return new(UpdateStatus.NetworkError, current, Error: ex.Message); }
        catch (JsonException ex) { return new(UpdateStatus.NetworkError, current, Error: ex.Message); }
        catch (InvalidOperationException) { return new(UpdateStatus.NetworkError, current, Error: "invalid release metadata"); }
    }

    public static Version? ParseStableVersion(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var value = tag.Trim();
        if (value.StartsWith('v')) value = value[1..];
        if (value.Contains('-', StringComparison.Ordinal) || value.Contains('+', StringComparison.Ordinal)) return null;
        var parts = value.Split('.');
        if (parts.Length != 3 || parts.Any(part => part.Length == 0 || part.Any(ch => ch < '0' || ch > '9'))) return null;
        return Version.TryParse(value, out var version) ? version : null;
    }

    public static bool TryReleaseUrl(string? value, out Uri uri)
    {
        uri = null!;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var candidate) || candidate.Scheme != Uri.UriSchemeHttps || candidate.UserInfo.Length != 0 || !candidate.IsDefaultPort || !candidate.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)) return false;
        var path = candidate.AbsolutePath.TrimEnd('/');
        if (!path.StartsWith("/" + Repository + "/releases/tag/", StringComparison.OrdinalIgnoreCase)) return false;
        uri = candidate; return true;
    }

    public void Dispose() => _http.Dispose();
}
