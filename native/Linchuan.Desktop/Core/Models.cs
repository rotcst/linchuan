using System.Text.Json.Serialization;

namespace Linchuan.Desktop.Core;

public enum DeviceType
{
    [JsonStringEnumMemberName("computer")]
    Computer,
    [JsonStringEnumMemberName("phone")]
    Phone,
    [JsonStringEnumMemberName("tablet")]
    Tablet,
}

public sealed class Device
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public DeviceType Type { get; set; }
    public bool Online { get; set; }
    public long? LastSeen { get; set; }
}

public sealed class FileRef
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public long Size { get; set; }
    public string Mime { get; set; } = "application/octet-stream";
}

public sealed class ChatMessage
{
    public string Id { get; set; } = string.Empty;
    public string? ClientId { get; set; }
    public string From { get; set; } = string.Empty;
    public string To { get; set; } = string.Empty;
    public string Text { get; set; } = string.Empty;
    public long CreatedAt { get; set; }
    public string Kind { get; set; } = "text";
    public FileRef? File { get; set; }
}

public sealed class SessionInfo
{
    public string Token { get; set; } = string.Empty;
    public Device Device { get; set; } = new();
    public List<Device> Devices { get; set; } = [];
    public long? ExpiresAt { get; set; }
    public long? MaxFileBytes { get; set; }
    public long? MaxStorageBytes { get; set; }
}

public sealed class ServerInfo
{
    public int DesktopApi { get; set; }
    public string ServerName { get; set; } = string.Empty;
    public List<string> Urls { get; set; } = [];
    public double? ExpiresHours { get; set; }
    public bool Persistent { get; set; }
    public long? MaxFileBytes { get; set; }
    public long? MaxStorageBytes { get; set; }
    public string? PublicUrl { get; set; }
}

public sealed class HostInfo
{
    public string Code { get; set; } = string.Empty;
    public bool JoinLocked { get; set; }
    public string? Internet { get; set; }
    public string? LocalUrl { get; set; }
    public string? PublicUrl { get; set; }
}

public sealed class DeviceList
{
    public List<Device> Devices { get; set; } = [];
}

public sealed class HistoryPage
{
    public List<ChatMessage> Messages { get; set; } = [];
    public bool HasMore { get; set; }
    public long? Before { get; set; }
    public string? BeforeId { get; set; }
}

public sealed class UploadProgress
{
    public long UploadedBytes { get; init; }
    public long TotalBytes { get; init; }
    public int Percent => TotalBytes <= 0
        ? 100
        : (int)Math.Truncate(Math.Clamp((double)UploadedBytes / TotalBytes * 100d, 0d, 100d));
}
