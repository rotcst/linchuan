namespace Linchuan.Desktop;

internal static class ManagedPaths
{
    public static void Check(string path)
    {
        for (var current = Path.GetFullPath(path); !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            var info = new FileInfo(current);
            if (info.LinkTarget is not null || (File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Managed application paths cannot contain symbolic links or junctions.");
        }
    }
    public static void Create(string path) { Check(path); Directory.CreateDirectory(path); Check(path); }
}
