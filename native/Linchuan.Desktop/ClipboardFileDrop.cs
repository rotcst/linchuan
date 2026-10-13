using System.Collections;
using System.Runtime.InteropServices;
using System.Windows;

namespace Linchuan.Desktop;

internal static class ClipboardFileDrop
{
    public static string[]? TryGetPaths(IDataObject data)
    {
        try
        {
            if (!data.GetDataPresent(DataFormats.FileDrop, true)) return null;
            var value = data.GetData(DataFormats.FileDrop, true);
            if (value is string[] paths) return Normalize(paths);
            if (value is IEnumerable values)
                return Normalize(values.OfType<string>().ToArray());
        }
        catch (ExternalException) { }
        catch (ArgumentException) { }
        return null;
    }

    private static string[]? Normalize(IEnumerable<string> paths)
    {
        var result = paths
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => path.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return result.Length == 0 ? null : result;
    }
}
