namespace Linchuan.Desktop;

internal static class AppVersion
{
    public static Version Current => Core.UpdateChecker.CurrentVersion();
    public static string Display => Current.ToString(3);
}
