using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class LinchuanLauncher
{
    private const string Product = "邻传";
    private static readonly Regex HashValue = new Regex(
        "^[0-9a-fA-F]{64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex FilesObject = new Regex(
        "\\\"files\\\"\\s*:\\s*\\{(?<body>.*?)\\}\\s*(?:,|\\})",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.Singleline);
    private static readonly Regex JsonProperty = new Regex(
        "(?<!\\\\)\\\"(?<path>(?:[^\\\"\\\\]|\\\\.)*)\\\"\\s*:",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static bool Diagnostic;

    private sealed class Options
    {
        public bool Local;
        public bool NoBrowser;
        public int Port = 3939;
        public string DataDir;
        public string AppDir;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var options = ParseOptions(args);
            var defaultBaseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Linchuan");
            var appDir = string.IsNullOrWhiteSpace(options.AppDir)
                ? Path.Combine(defaultBaseDir, "app")
                : Path.GetFullPath(options.AppDir);
            var baseDir = string.IsNullOrWhiteSpace(options.AppDir)
                ? defaultBaseDir
                : (Path.GetDirectoryName(appDir) ?? appDir);
            var dataDir = string.IsNullOrWhiteSpace(options.DataDir)
                ? Path.Combine(defaultBaseDir, "data")
                : Path.GetFullPath(options.DataDir);
            Directory.CreateDirectory(baseDir);
            EnsureSafeDirectory(baseDir);
            EnsureSafeDirectory(appDir, allowMissing: true);
            Directory.CreateDirectory(dataDir);
            EnsureSafeDirectory(dataDir);

            var url = "http://127.0.0.1:" + options.Port;
            if (Probe(url))
            {
                if (!options.NoBrowser) OpenBrowser(url);
                return 0;
            }

            ExtractAndVerify(appDir);
            var node = Path.Combine(appDir, "runtime", "node.exe");
            var server = Path.Combine(appDir, "build", "server.cjs");
            if (!File.Exists(node) || !File.Exists(server))
                throw new InvalidOperationException("发布包缺少 Node.js 运行时或服务文件。");

            var logDir = dataDir;
            Directory.CreateDirectory(logDir);
            var stdout = Path.Combine(logDir, "service.log");
            var stderr = Path.Combine(logDir, "service-error.log");
            var configuredInternet = File.Exists(Path.Combine(dataDir, "cloudflare.json")) &&
                File.Exists(Path.Combine(dataDir, "tunnel-token.dpapi"));
            var useInternet = configuredInternet && !options.Local;
            var startInfo = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "\"" + server + "\"",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.EnvironmentVariables["DATA_DIR"] = dataDir;
            startInfo.EnvironmentVariables["PORT"] = options.Port.ToString();
            startInfo.EnvironmentVariables["INTERNET"] = useInternet ? "1" : "0";
            startInfo.EnvironmentVariables["OPEN_BROWSER"] = "0";
            using (var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true })
            {
                process.OutputDataReceived += (_, e) => AppendLine(stdout, e.Data);
                process.ErrorDataReceived += (_, e) => AppendLine(stderr, e.Data);
                if (!process.Start()) throw new InvalidOperationException("无法启动邻传服务。");
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                for (var attempt = 0; attempt < 100; attempt++)
                {
                    if (Probe(url))
                    {
                        if (!options.NoBrowser) OpenBrowser(url);
                        // Keep the hidden launcher alive while the child runs so
                        // redirected stdout/stderr pipes stay drained. This also
                        // lets the launcher report a clean child exit.
                        process.WaitForExit();
                        return process.ExitCode;
                    }
                    if (process.HasExited)
                        throw new InvalidOperationException("服务启动失败，请查看 " + stderr + "。");
                    System.Threading.Thread.Sleep(200);
                }
            }
            throw new InvalidOperationException("服务启动超时，请查看 " + stderr + "。");
        }
        catch (Exception error)
        {
            if (Diagnostic) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, Product + "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static Options ParseOptions(string[] args)
    {
        var options = new Options();
        foreach (var arg in args ?? new string[0])
        {
            if (string.Equals(arg, "--local", StringComparison.OrdinalIgnoreCase))
                options.Local = true;
            else if (string.Equals(arg, "--diagnostic", StringComparison.OrdinalIgnoreCase))
                Diagnostic = true;
            else if (string.Equals(arg, "--noBrowser", StringComparison.OrdinalIgnoreCase))
                options.NoBrowser = true;
            else if (arg.StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
            {
                int port;
                if (!int.TryParse(arg.Substring(7), out port) || port <= 0 || port > 65535)
                    throw new ArgumentException("端口参数无效：" + arg);
                options.Port = port;
            }
            else if (arg.StartsWith("--dataDir=", StringComparison.OrdinalIgnoreCase))
                options.DataDir = arg.Substring(10);
            else if (arg.StartsWith("--app-dir=", StringComparison.OrdinalIgnoreCase))
                options.AppDir = arg.Substring(10);
            else if (!string.IsNullOrEmpty(arg))
                throw new ArgumentException("不支持的启动参数：" + arg);
        }
        return options;
    }

    private static bool Probe(string baseUrl)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/info");
            request.Method = "GET";
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream ?? Stream.Null, Encoding.UTF8, true))
            {
                var body = reader.ReadToEnd();
                if ((int)response.StatusCode != 200)
                    throw new InvalidOperationException("端口已被其他 HTTP 服务占用：" + response.StatusCode);
                if (!IsOurInfo(body))
                    throw new InvalidOperationException("端口已被其他 HTTP 服务占用（serverName 不匹配）。");
                return true;
            }
        }
        catch (WebException error)
        {
            if (error.Response != null)
                throw new InvalidOperationException("端口已被其他 HTTP 服务占用。", error);
            return false;
        }
        catch (IOException) { return false; }
    }

    private static bool IsOurInfo(string body)
    {
        try
        {
            var value = new JavaScriptSerializer().DeserializeObject(body) as Dictionary<string, object>;
            object serverName;
            return value != null && value.TryGetValue("serverName", out serverName) &&
                string.Equals(serverName as string, Product, StringComparison.Ordinal);
        }
        catch (InvalidOperationException) { return false; }
        catch (ArgumentException) { return false; }
    }

    private static void OpenBrowser(string url)
    {
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    private static void AppendLine(string path, string value)
    {
        if (value == null) return;
        try { File.AppendAllText(path, value + Environment.NewLine, Encoding.UTF8); }
        catch { /* The service remains useful even if diagnostics cannot be written. */ }
    }

    private static void EnsureSafeDirectory(string directory, bool allowMissing = false)
    {
        var full = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        if (!Directory.Exists(full))
        {
            if (allowMissing) return;
            Directory.CreateDirectory(full);
        }
        var info = new DirectoryInfo(full);
        info.Refresh();
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("拒绝使用符号链接或 reparse point 目录：" + full);
    }

    private static void ExtractAndVerify(string appDir)
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        {
            if (stream == null) throw new InvalidOperationException("启动器缺少内嵌发布包。");
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Read, false, Encoding.UTF8))
            {
                var manifestEntry = archive.GetEntry("manifest.json");
                if (manifestEntry == null) throw new InvalidOperationException("发布包缺少 manifest.json。");
                string manifest;
                using (var reader = new StreamReader(manifestEntry.Open(), Encoding.UTF8, true))
                    manifest = reader.ReadToEnd();
                var files = ParseManifest(manifest);
                var expected = new HashSet<string>(files.Keys, StringComparer.OrdinalIgnoreCase);
                expected.Add("manifest.json");
                foreach (var entry in archive.Entries)
                {
                    var name = NormalizeArchivePath(entry.FullName);
                    if (string.IsNullOrEmpty(name)) continue;
                    if (!expected.Contains(name))
                        throw new InvalidOperationException("发布包包含未声明文件：" + name);
                }
                foreach (var pair in files)
                    ExtractFile(archive, appDir, pair.Key, pair.Value);
                WriteManagedFile(archive, appDir, "manifest.json", manifestEntry);
            }
        }
    }

    private static Dictionary<string, string> ParseManifest(string json)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var root = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
        object filesValue;
        var files = root != null && root.TryGetValue("files", out filesValue)
            ? filesValue as Dictionary<string, object>
            : null;
        if (files == null) throw new InvalidOperationException("manifest.json 缺少 files 字典。");
        var filesMatch = FilesObject.Match(json);
        if (!filesMatch.Success) throw new InvalidOperationException("manifest.json 的 files 字典格式无效。");
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in JsonProperty.Matches(filesMatch.Groups["body"].Value))
        {
            var path = Regex.Unescape(match.Groups["path"].Value).Replace('\\', '/');
            if (!seenPaths.Add(path)) throw new InvalidOperationException("manifest.json 包含重复文件：" + path);
        }
        foreach (var pair in files)
        {
            var path = pair.Key.Replace('\\', '/');
            ValidateRelativePath(path);
            var hash = pair.Value as string;
            if (hash == null || !HashValue.IsMatch(hash))
                throw new InvalidOperationException("manifest.json 包含无效 SHA-256：" + path);
            if (result.ContainsKey(path))
                throw new InvalidOperationException("manifest.json 包含重复文件：" + path);
            result.Add(path, hash.ToLowerInvariant());
        }
        if (result.Count == 0) throw new InvalidOperationException("manifest.json 没有可验证的文件清单。");
        return result;
    }

    private static string NormalizeArchivePath(string value)
    {
        if (value == null || value.EndsWith("/", StringComparison.Ordinal) ||
            value.EndsWith("\\", StringComparison.Ordinal)) return string.Empty;
        var normalized = value.Replace('\\', '/');
        ValidateRelativePath(normalized);
        return normalized;
    }

    private static void ValidateRelativePath(string value)
    {
        if (string.IsNullOrEmpty(value) || value.StartsWith("/", StringComparison.Ordinal) ||
            value.Contains(":") || value.Split('/').Any(part => part == ".." || part.Length == 0))
            throw new InvalidOperationException("发布包包含不安全路径：" + value);
    }

    private static void ExtractFile(ZipArchive archive, string appDir, string relative, string expectedHash)
    {
        var entry = FindEntry(archive, relative);
        if (entry == null) throw new InvalidOperationException("发布包缺少文件：" + relative);
        WriteManagedFile(archive, appDir, relative, entry, expectedHash);
    }

    private static ZipArchiveEntry FindEntry(ZipArchive archive, string relative)
    {
        foreach (var entry in archive.Entries)
        {
            if (string.Equals(NormalizeArchivePath(entry.FullName), relative, StringComparison.OrdinalIgnoreCase))
                return entry;
        }
        return null;
    }

    private static void WriteManagedFile(ZipArchive archive, string appDir, string relative, ZipArchiveEntry entry, string expectedHash = null)
    {
        ValidateRelativePath(relative);
        var target = Path.GetFullPath(Path.Combine(appDir, relative.Replace('/', Path.DirectorySeparatorChar)));
        var root = Path.GetFullPath(appDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("发布包路径越界。");
        var parent = Path.GetDirectoryName(target);
        if (parent == null) throw new InvalidOperationException("发布包路径无效。");
        EnsureParentsSafe(appDir, parent);
        if (File.Exists(target) && (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("拒绝覆盖 reparse point 文件：" + relative);
        var temp = target + ".linchuan-update-" + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var input = entry.Open())
            using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                input.CopyTo(output);
            if (expectedHash != null && !string.Equals(HashFile(temp), expectedHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("发布文件校验失败：" + relative);
            if (File.Exists(target)) File.Replace(temp, target, null);
            else File.Move(temp, target);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    private static void EnsureParentsSafe(string appDir, string parent)
    {
        var root = new DirectoryInfo(Path.GetFullPath(appDir));
        if (!root.Exists) root.Create();
        root.Refresh();
        if ((root.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("拒绝使用 reparse point 发布目录：" + root.FullName);
        var current = new DirectoryInfo(Path.GetFullPath(parent));
        var chain = new Stack<DirectoryInfo>();
        while (current != null && !string.Equals(current.FullName, root.FullName, StringComparison.OrdinalIgnoreCase))
        {
            chain.Push(current);
            current = current.Parent;
        }
        if (current == null) throw new InvalidOperationException("发布包目录越界。");
        while (chain.Count > 0)
        {
            var dir = chain.Pop();
            if (!dir.Exists) dir.Create();
            // DirectoryInfo caches Attributes. Refresh after creating a new
            // directory so a missing entry (-1) cannot be mistaken for a
            // reparse point by the safety check below.
            dir.Refresh();
            if ((dir.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("拒绝写入 reparse point 目录：" + dir.FullName);
        }
    }

    private static string HashFile(string path)
    {
        using (var sha = SHA256.Create())
        using (var input = File.OpenRead(path))
            return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }
}
