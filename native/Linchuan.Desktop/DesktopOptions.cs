using System.Text.Json;

namespace Linchuan.Desktop;

public sealed class DesktopOptions
{
    private static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Linchuan");
    public string AppDir { get; set; } = Path.Combine(Root, "app");
    public string DataDir { get; set; } = Path.Combine(Root, "data");
    public string ClientDir { get; set; } = Path.Combine(Root, "desktop");
    public int Port { get; set; } = 3939;
    public bool LocalOnly { get; set; }
    public string? ServerUri { get; set; }
    public string? VerifyOutput { get; set; }
    public string DeviceId { get; set; } = "";
    public static DesktopOptions Parse(string[] args)
    {
        var options = new DesktopOptions();
        for (var i = 0; i < args.Length; i++)
        {
            string Value() => ++i < args.Length ? args[i] : throw new ArgumentException("Missing option value.");
            switch (args[i])
            {
                case "--app-dir": options.AppDir = Path.GetFullPath(Value()); break;
                case "--data-dir": options.DataDir = Path.GetFullPath(Value()); break;
                case "--client-dir": options.ClientDir = Path.GetFullPath(Value()); break;
                case "--port": options.Port = int.Parse(Value(), System.Globalization.CultureInfo.InvariantCulture); break;
                case "--server":
                    var server = new Uri(Value(), UriKind.Absolute);
                    if (server.Scheme is not ("http" or "https") || server.UserInfo.Length > 0) throw new ArgumentException("HTTP or HTTPS address without credentials required.");
                    options.ServerUri = server.GetLeftPart(UriPartial.Authority); break;
                case "--local": options.LocalOnly = true; break;
                case "--verify": options.VerifyOutput = Path.GetFullPath(Value()); break;
                default: throw new ArgumentException("Unknown option: " + args[i]);
            }
        }
        if (options.Port is < 1024 or > 65535) throw new ArgumentException("Port must be between 1024 and 65535.");
        if (options.ServerUri is not null && new Uri(options.ServerUri).Scheme is not ("http" or "https")) throw new ArgumentException("HTTP or HTTPS required.");
        ManagedPaths.Create(options.ClientDir);
        return options;
    }
}

public sealed class Preferences
{
    public string Language { get; set; } = L.DefaultLanguage;
    public string Theme { get; set; } = "system";
    public string Server { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public static Preferences Load(string directory)
    {
        try { return JsonSerializer.Deserialize<Preferences>(File.ReadAllText(Path.Combine(directory, "ui.json"))) ?? new(); }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }
    public void Save(string directory)
    {
        var file = Path.Combine(directory, "ui.json");
        ManagedPaths.Check(file);
        var temp = file + ".tmp-" + Guid.NewGuid().ToString("N");
        try { File.WriteAllText(temp, JsonSerializer.Serialize(this)); File.Move(temp, file, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
