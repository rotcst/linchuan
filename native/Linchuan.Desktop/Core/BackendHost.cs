using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Json;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace Linchuan.Desktop.Core;

public sealed class BackendHost : IAsyncDisposable
{
    private Process? _process;
    private string? _dataDir;
    private int _port;

    public async Task<bool> StartAsync(string appDir, string dataDir, int port, bool localOnly, CancellationToken ct = default)
    {
        if (port is < 1 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        appDir = Path.GetFullPath(appDir); dataDir = Path.GetFullPath(dataDir);
        EnsureSafeAncestorsBeforeCreate(dataDir); Directory.CreateDirectory(dataDir); EnsureSafeDirectory(dataDir);
        EnsureSafeAncestorsBeforeCreate(appDir);
        var configuredPublicUrl = ReadPublicUrl(dataDir);
        if (configuredPublicUrl is null && File.Exists(Path.Combine(dataDir, "cloudflare.json")))
            throw new InvalidOperationException("无法读取公网入口配置，请检查 cloudflare.json。");
        var existing = await ProbeAsync(port, configuredPublicUrl, ct);
        if (existing == true) return false;
        if (existing is null) throw new InvalidOperationException("目标端口已被其他服务占用。");
        var payload = FindPayload();
        if (payload is null) throw new InvalidOperationException("程序未包含后端 payload。");
        await using (payload) await ExtractPayload(payload, appDir, ct);
        var node = Path.Combine(appDir, "runtime", "node.exe");
        var server = Path.Combine(appDir, "build", "server.cjs");
        if (!File.Exists(node) || !File.Exists(server)) throw new InvalidDataException("后端 payload 缺少 Node 或 server.cjs。");
        var psi = new ProcessStartInfo(node, $"\"{server}\"")
        {
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["DATA_DIR"] = dataDir; psi.Environment["PORT"] = port.ToString();
        var internetConfigured = configuredPublicUrl is not null && File.Exists(Path.Combine(dataDir, "tunnel-token.dpapi"));
        psi.Environment["INTERNET"] = !localOnly && internetConfigured ? "1" : "0"; psi.Environment["OPEN_BROWSER"] = "0";
        // Keep a configured URL visible in the desktop inspector even when the
        // tunnel is deliberately disabled; INTERNET remains gated by token and --local.
        psi.Environment["PUBLIC_URL"] = configuredPublicUrl ?? string.Empty;
        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.Start();
        _process = process; _dataDir = dataDir; _port = port;
        var stdout = Path.Combine(dataDir, "native-backend.stdout.log");
        var stderr = Path.Combine(dataDir, "native-backend.stderr.log");
        AppendLine(stdout, $"桌面启动配置: 公网入口={configuredPublicUrl ?? "未配置"}; 互联网通道={psi.Environment["INTERNET"]}");
        process.OutputDataReceived += (_, e) => AppendLine(stdout, e.Data);
        process.ErrorDataReceived += (_, e) => AppendLine(stderr, e.Data);
        process.BeginOutputReadLine(); process.BeginErrorReadLine();
        try
        {
            for (var i = 0; i < 100; i++)
            {
                ct.ThrowIfCancellationRequested();
                if (process.HasExited) throw new InvalidOperationException("后端进程提前退出。");
                if (await ProbeAsync(port, configuredPublicUrl, ct) == true) return true;
                await Task.Delay(200, ct);
            }
            throw new TimeoutException("后端启动超时。");
        }
        catch { await DisposeAsync(); throw; }
    }

    public async ValueTask DisposeAsync()
    {
        var process = Interlocked.Exchange(ref _process, null);
        if (process is null) return;
        try
        {
            try
            {
                using var stop = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
                using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{_port}/api/host/stop");
                request.Headers.TryAddWithoutValidation("X-Linchuan-Host", "1");
                await stop.SendAsync(request, CancellationToken.None);
            }
            catch { }
            for (var i = 0; i < 10 && !process.HasExited; i++) await Task.Delay(200);
            if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
        }
        catch { }
        finally { process.Dispose(); _dataDir = null; _port = 0; }
    }

    public static Task ExtractPayload(Stream zipStream, string appDir, CancellationToken ct = default) => ExtractPayload(zipStream, appDir, ct, true);

    private static async Task ExtractPayload(Stream zipStream, string appDir, CancellationToken ct, bool requireManifest)
    {
        appDir = Path.GetFullPath(appDir);
        EnsureSafeAncestorsBeforeCreate(appDir);
        if (File.Exists(appDir)) throw new InvalidDataException("payload 目标路径不是目录。");
        if (Directory.Exists(appDir)) EnsureSafeTree(appDir);
        var parent = Path.GetDirectoryName(appDir) ?? throw new InvalidDataException("payload 目标目录无父目录。");
        EnsureSafeAncestorsBeforeCreate(parent);
        Directory.CreateDirectory(parent);
        EnsureSafeDirectory(parent);
        var stage = Path.Combine(parent, "." + Path.GetFileName(appDir) + ".staging-" + Guid.NewGuid().ToString("N"));
        var backup = Path.Combine(parent, "." + Path.GetFileName(appDir) + ".backup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        EnsureSafeDirectory(stage);
        try
        {
            using var archive = new ZipArchive(zipStream, ZipArchiveMode.Read, leaveOpen: true);
            var manifestEntry = archive.GetEntry("manifest.json") ?? throw new InvalidDataException("payload 缺少 manifest.json。");
            using var manifestReader = new StreamReader(manifestEntry.Open());
            var manifest = ParseManifest(await manifestReader.ReadToEndAsync(ct));
            var declared = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in manifest.Files) { var safe = SafeRelative(file.Key); if (!RegexHash(file.Value) || !declared.TryAdd(safe, file.Value)) throw new InvalidDataException("manifest 文件清单无效。"); }
            var archivePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in archive.Entries)
            {
                if (entry.FullName.EndsWith('/')) continue;
                var relative = SafeRelative(entry.FullName);
                if (!archivePaths.Add(relative)) throw new InvalidDataException("payload 存在重复文件。");
                if (!string.Equals(relative, "manifest.json", StringComparison.OrdinalIgnoreCase) && !declared.ContainsKey(relative)) throw new InvalidDataException("payload 含未声明文件。");
            }
            foreach (var pair in declared)
            {
                ct.ThrowIfCancellationRequested(); var entry = archive.GetEntry(pair.Key) ?? throw new InvalidDataException("manifest 文件缺失。");
                var target = Path.GetFullPath(Path.Combine(stage, pair.Key)); var targetParent = Path.GetDirectoryName(target)!;
                EnsureUnder(stage, target); EnsureSafeAncestors(stage, targetParent); Directory.CreateDirectory(targetParent); EnsureSafeDirectory(targetParent);
                var temp = target + ".tmp-" + Guid.NewGuid().ToString("N");
                try
                {
                    {
                        await using var input = entry.Open();
                        await using var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous);
                        await input.CopyToAsync(output, 128 * 1024, ct);
                    }
                    string hash;
                    {
                        await using var check = new FileStream(temp, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.Asynchronous);
                        hash = Convert.ToHexString(await SHA256.HashDataAsync(check, ct)).ToLowerInvariant();
                    }
                    if (!hash.Equals(pair.Value, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("payload 文件校验失败。");
                    MoveFileWithRetries(temp, target);
                }
                finally { try { if (File.Exists(temp)) File.Delete(temp); } catch { } }
            }
        }
        catch
        {
            if (Directory.Exists(stage))
            {
                EnsureSafeTree(stage);
                Directory.Delete(stage, true);
            }
            throw;
        }

        EnsureSafeTree(stage);
        var oldMoved = false;
        var newMoved = false;
        try
        {
            if (Directory.Exists(appDir)) { MoveDirectoryWithRetries(appDir, backup); oldMoved = true; }
            MoveDirectoryWithRetries(stage, appDir); newMoved = true;
        }
        catch
        {
            try
            {
                if (newMoved && Directory.Exists(appDir)) { EnsureSafeTree(appDir); Directory.Delete(appDir, true); }
                if (oldMoved && !Directory.Exists(appDir)) MoveDirectoryWithRetries(backup, appDir);
            }
            catch (Exception rollback) { throw new IOException("payload 切换失败且回滚失败。", rollback); }
            throw;
        }
        finally
        {
            if (oldMoved && newMoved && Directory.Exists(backup))
            {
                EnsureSafeAncestorsBeforeCreate(parent); EnsureSafeTree(backup);
                Directory.Delete(backup, true);
            }
            else if (Directory.Exists(stage))
            {
                EnsureSafeTree(stage);
                Directory.Delete(stage, true);
            }
        }
    }

    private static async Task<bool?> ProbeAsync(int port, string? configuredPublicUrl, CancellationToken ct)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        try
        {
            using var response = await client.GetAsync($"http://127.0.0.1:{port}/api/info", ct); if (!response.IsSuccessStatusCode) return null;
            var info = await response.Content.ReadFromJsonAsync<ServerInfo>(cancellationToken: ct);
            if (info?.ServerName != "邻传") return null;
            if (info.DesktopApi < 2) throw new InvalidOperationException("旧版服务仍在运行，请先退出旧版邻传，再启动桌面程序。数据会保留。");
            if (!string.Equals(info.PublicUrl, configuredPublicUrl, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("现有服务的公网入口配置与当前桌面配置不一致，请先退出现有邻传服务，再启动桌面程序。数据会保留。");
            return true;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return null; }
    }

    private static Stream? FindPayload()
    {
        var asm = Assembly.GetEntryAssembly() ?? Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames().FirstOrDefault(x => x.EndsWith("payload.zip", StringComparison.OrdinalIgnoreCase));
        return name is null ? null : asm.GetManifestResourceStream(name);
    }
    private static void AppendLine(string path, string? line) { if (line is null) return; try { File.AppendAllText(path, line + Environment.NewLine); } catch { } }
    private static string? ReadPublicUrl(string dataDir)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(dataDir, "cloudflare.json")));
            if (!document.RootElement.TryGetProperty("publicUrl", out var value) || value.ValueKind != JsonValueKind.String) return null;
            var text = value.GetString();
            if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || uri.UserInfo.Length > 0 || string.IsNullOrWhiteSpace(uri.Host)) return null;
            return uri.GetLeftPart(UriPartial.Authority);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        { throw new InvalidOperationException("无法读取公网入口配置，请检查 cloudflare.json。", ex); }
    }
    private static void EnsureSafeDirectory(string path) { if (File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("不允许 reparse point。"); }
    private static void EnsureSafeTree(string path)
    {
        EnsureSafeDirectory(path);
        foreach (var item in Directory.EnumerateFileSystemEntries(path, "*", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = false, ReturnSpecialDirectories = false }))
            if (File.GetAttributes(item).HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("不允许 reparse point。");
    }
    private static void MoveFileWithRetries(string source, string destination)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try { File.Move(source, destination); return; }
            catch (IOException ex) when (attempt < 3) { last = ex; Thread.Sleep(attempt * 100); }
            catch (UnauthorizedAccessException ex) when (attempt < 3) { last = ex; Thread.Sleep(attempt * 100); }
        }
        throw last ?? new IOException("payload 文件切换失败。");
    }
    private static void MoveDirectoryWithRetries(string source, string destination)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try { Directory.Move(source, destination); return; }
            catch (IOException ex) when (attempt < 3) { last = ex; Thread.Sleep(attempt * 100); }
            catch (UnauthorizedAccessException ex) when (attempt < 3) { last = ex; Thread.Sleep(attempt * 100); }
        }
        throw last ?? new IOException("payload 目录切换失败。");
    }
    private static void EnsureSafeAncestorsBeforeCreate(string path)
    {
        for (var current = Path.GetFullPath(path); !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            if (Directory.Exists(current)) EnsureSafeDirectory(current);
            if (File.Exists(current)) throw new InvalidDataException("目标路径不是目录。");
        }
    }
    private static void EnsureSafeAncestors(string root, string path)
    {
        root = Path.GetFullPath(root); path = Path.GetFullPath(path);
        for (var current = path; current.StartsWith(root, StringComparison.OrdinalIgnoreCase); current = Path.GetDirectoryName(current) ?? root)
        {
            if (Directory.Exists(current)) EnsureSafeDirectory(current);
            if (string.Equals(current, root, StringComparison.OrdinalIgnoreCase)) break;
        }
    }
    private static void EnsureUnder(string root, string path) { var prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar; if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("路径越界。"); }
    private static string SafeRelative(string path) { if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path) || path.Contains(':')) throw new InvalidDataException("非法 payload 路径。"); var s = path.Replace('\\', '/'); if (s.Split('/').Any(x => x is "" or "." or "..")) throw new InvalidDataException("非法 payload 路径。"); return s; }
    private static bool RegexHash(string value) => value.Length == 64 && value.All(Uri.IsHexDigit);
    private static Manifest ParseManifest(string json)
    {
        using var document = JsonDocument.Parse(json);
        var roots = document.RootElement.EnumerateObject().Where(p => string.Equals(p.Name, "files", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (roots.Length != 1 || roots[0].Value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("manifest files 字段无效或重复。");
        var files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in roots[0].Value.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String || !files.TryAdd(property.Name, property.Value.GetString() ?? string.Empty)) throw new InvalidDataException("manifest 文件清单无效或重复。");
        }
        if (files.Count == 0 || files.Values.Any(hash => !RegexHash(hash))) throw new InvalidDataException("manifest 文件清单无效。");
        return new Manifest(files);
    }
    private sealed record Manifest(Dictionary<string, string> Files);
}
