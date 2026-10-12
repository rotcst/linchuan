using System.Reflection;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace Linchuan.Desktop;

public static class L
{
    private static Dictionary<string, string> _catalog = [];
    public static string DefaultLanguage => System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName switch { "ko" => "ko", "ja" => "ja", "en" => "en", _ => "zh" };
    public static string Language { get; private set; } = DefaultLanguage;
    public static void Set(string language)
    {
        Language = new[] { "zh", "en", "ko", "ja" }.Contains(language) ? language : "zh";
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("locales." + Language + ".json")!;
        _catalog = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(stream)!;
    }
    public static string T(string key) => _catalog.GetValueOrDefault(key, key);
}

public static class Theme
{
    private static readonly Dictionary<string, string> Light = [];
    private static readonly Dictionary<string, string> Dark = [];
    public static bool IsDark { get; private set; }
    public static event Action? Changed;
    static Theme()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("tokens.css")!;
        using var reader = new StreamReader(stream);
        var css = reader.ReadToEnd();
        ReadBlock(Regex.Match(css, @":root\s*\{([^}]+)\}", RegexOptions.Singleline).Groups[1].Value, Light);
        foreach (var entry in Light) Dark[entry.Key] = entry.Value;
        ReadBlock(Regex.Match(css, @":root\[data-theme='dark'\]\s*\{([^}]+)\}", RegexOptions.Singleline).Groups[1].Value, Dark);
    }
    private static void ReadBlock(string css, Dictionary<string, string> into)
    {
        foreach (Match match in Regex.Matches(css, @"--([\w-]+)\s*:\s*([^;]+);")) into[match.Groups[1].Value] = match.Groups[2].Value.Trim();
    }
    private static string Resolve(string key)
    {
        var values = IsDark ? Dark : Light;
        var value = values[key];
        for (var i = 0; value.StartsWith("var(--", StringComparison.Ordinal) && i < 10; i++) value = values[value[6..^1]];
        return value;
    }
    public static double Number(string key, double fallback) => double.TryParse(Resolve(key).Replace("px", "", StringComparison.Ordinal), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : fallback;
    public static void Apply(string preference)
    {
        IsDark = preference == "dark" || preference == "system" && (int?)Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1) == 0;
        var resources = Application.Current.Resources;
        foreach (var (name, token) in new Dictionary<string, string>
        {
            ["Page"] = "color-page",
            ["Surface"] = "color-surface",
            ["Rail"] = "color-rail",
            ["Field"] = "color-field",
            ["Text"] = "color-text",
            ["Muted"] = "color-muted",
            ["Border"] = "color-border",
            ["Accent"] = "color-accent",
            ["AccentHover"] = "color-accent-hover",
            ["OnAccent"] = "color-on-accent",
            ["Selected"] = "color-selected",
            ["Danger"] = "color-danger",
            ["Offline"] = "color-offline",
            ["Hover"] = "color-hover",
            ["TraySurface"] = "tray-menu-bg",
            ["TrayActive"] = "tray-menu-active-bg",
            ["TrayActiveText"] = "tray-menu-active-text",
            ["ToastSurface"] = "toast-bg",
            ["ToastText"] = "toast-text"
        })
            resources[name] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(Resolve(token)));
        resources["Font"] = new FontFamily(L.Language switch { "ko" => "Malgun Gothic", "ja" => "Yu Gothic UI", _ => "Microsoft YaHei UI" });
        if (!resources.Contains(typeof(System.Windows.Controls.Primitives.ScrollBar))) Ui.InstallScrollBars();
        Changed?.Invoke();
    }
}
