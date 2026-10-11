using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Cryptography;
using System.Text;

namespace Linchuan.Desktop.Core;

public sealed class DesktopSettings
{
    public string ServerUri { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public DeviceType Type { get; set; } = DeviceType.Computer;
    public int Port { get; set; } = 3939;
    public string AppDir { get; set; } = string.Empty;
    public string DataDir { get; set; } = string.Empty;
    [JsonIgnore] public string? SessionToken { get; set; }
    [JsonPropertyName("protectedToken")] public string? ProtectedToken { get; set; }
}

public sealed class SettingsStore
{
    private readonly string _path;
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
        WriteIndented = true,
    };

    public SettingsStore(string path) => _path = Path.GetFullPath(path);

    public async Task<DesktopSettings?> LoadAsync(string serverUri, string deviceId, CancellationToken ct = default)
    {
        if (!File.Exists(_path)) return null;
        try
        {
            await using var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read, 16 * 1024, FileOptions.Asynchronous);
            var root = await JsonSerializer.DeserializeAsync<StoreDocument>(stream, Options, ct) ?? new();
            var key = MakeKey(serverUri, deviceId);
            if (!root.Entries.TryGetValue(key, out var entry)) return null;
            entry.ServerUri = serverUri;
            entry.DeviceId = deviceId;
            entry.SessionToken = Unprotect(entry.ProtectedToken);
            return entry;
        }
        catch (JsonException) { return null; }
        catch (CryptographicException) { return null; }
        catch (FormatException) { return null; }
        catch (IOException) { return null; }
    }

    public async Task SaveAsync(DesktopSettings settings, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(settings.ServerUri) || string.IsNullOrWhiteSpace(settings.DeviceId))
            throw new ArgumentException("ServerUri and DeviceId are required.");
        var root = new StoreDocument();
        if (File.Exists(_path))
        {
            try
            {
                await using var input = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read, 16 * 1024, FileOptions.Asynchronous);
                root = await JsonSerializer.DeserializeAsync<StoreDocument>(input, Options, ct) ?? new();
            }
            catch (JsonException) { root = new(); }
            catch (IOException) { root = new(); }
        }
        var copy = new DesktopSettings
        {
            ServerUri = settings.ServerUri,
            DeviceId = settings.DeviceId,
            Name = settings.Name,
            Type = settings.Type,
            Port = settings.Port,
            AppDir = settings.AppDir,
            DataDir = settings.DataDir,
            ProtectedToken = Protect(settings.SessionToken),
        };
        root.Entries[MakeKey(settings.ServerUri, settings.DeviceId)] = copy;
        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var temp = _path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            {
                await using var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16 * 1024, FileOptions.Asynchronous);
                await JsonSerializer.SerializeAsync(output, root, Options, ct);
            }
            if (File.Exists(_path)) File.Replace(temp, _path, null);
            else File.Move(temp, _path);
        }
        finally { try { if (File.Exists(temp)) File.Delete(temp); } catch { } }
    }

    private static string MakeKey(string serverUri, string deviceId)
    {
        var origin = new Uri(serverUri, UriKind.Absolute).GetLeftPart(UriPartial.Authority).TrimEnd('/').ToLowerInvariant();
        return origin + "\n" + deviceId;
    }

    private static string? Protect(string? token)
    {
        if (string.IsNullOrEmpty(token)) return null;
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(bytes);
    }

    private static string? Unprotect(string? token)
    {
        if (string.IsNullOrEmpty(token)) return null;
        var bytes = ProtectedData.Unprotect(Convert.FromBase64String(token), null, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes);
    }

    private sealed class StoreDocument
    {
        public Dictionary<string, DesktopSettings> Entries { get; set; } = new(StringComparer.Ordinal);
    }
}
