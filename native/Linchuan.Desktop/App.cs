using System.IO.Pipes;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using Linchuan.Desktop.Core;
using Forms = System.Windows.Forms;

namespace Linchuan.Desktop;

public static class App
{
    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            var options = DesktopOptions.Parse(args);
            var startupPreferences = Preferences.Load(options.ClientDir);
            if (options.VerifyOutput is null && options.ServerUri is null)
            {
                if (startupPreferences.Hosting == false && startupPreferences.Server.Length > 0) options.ServerUri = startupPreferences.Server;
                else if (startupPreferences.Hosting == true && startupPreferences.HostDataDir.Length > 0) { ManagedPaths.Check(startupPreferences.HostDataDir); options.DataDir = startupPreferences.HostDataDir; if (!options.PortSpecified && startupPreferences.HostPort is >= 1024 and <= 65535) options.Port = startupPreferences.HostPort; }
            }
            var identity = Path.GetFullPath(options.ClientDir).ToLowerInvariant() + "|" + options.Port;
            var name = "Linchuan.Desktop." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..24];
            using var mutex = new Mutex(true, "Local\\" + name, out var owner);
            if (!owner) { ActivateAsync(name).GetAwaiter().GetResult(); return 0; }
            var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var host = new BackendHost(); MainWindow? window = null; Forms.NotifyIcon? tray = null; TrayMenu? trayMenu = null;
            using var life = new CancellationTokenSource(); var stopping = false;
            async Task StopAsync()
            {
                if (stopping) return; stopping = true; life.Cancel(); trayMenu?.Dispose(); tray?.Dispose(); if (window is not null) await window.ShutdownAsync(); await host.DisposeAsync(); application.Shutdown();
            }
            application.Startup += async (_, _) =>
            {
                try
                {
                    var saved = Preferences.Load(options.ClientDir); L.Set(saved.Language);
                    if (options.ServerUri is null) await host.StartAsync(options.AppDir, options.DataDir, options.Port, options.LocalOnly, life.Token);
                    window = new MainWindow(options, host); application.MainWindow = window; window.ExitRequested += async () => await StopAsync(); window.Show();
                    if (options.VerifyOutput is not null) { await NativeVerification.RunAsync(window, options); await StopAsync(); return; }
                    using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("assets.app.ico");
                    tray = new Forms.NotifyIcon { Icon = stream is null ? System.Drawing.SystemIcons.Application : new System.Drawing.Icon(stream), Text = "Linchuan", Visible = true };
                    trayMenu = new TrayMenu(() => Activate(window), async () => await StopAsync(), () => window.CheckForUpdatesAsync());
                    tray.MouseUp += (_, e) => { if (e.Button == Forms.MouseButtons.Right) application.Dispatcher.Invoke(trayMenu.ShowForTray); };
                    tray.DoubleClick += (_, _) => application.Dispatcher.Invoke(() => Activate(window));
                    _ = ListenAsync(name, () => application.Dispatcher.BeginInvoke(() => Activate(window)), life.Token);
                }
                catch (Exception ex)
                {
                    if (options.VerifyOutput is not null) { Directory.CreateDirectory(Path.GetDirectoryName(options.VerifyOutput)!); if (!File.Exists(options.VerifyOutput)) File.WriteAllText(options.VerifyOutput, System.Text.Json.JsonSerializer.Serialize(new { passed = false, error = ex.ToString(), packagedProcess = NativeWindowCapture.IsPackagedProcess })); }
                    else AppDialog.Show(L.T(ex.Message) + "\n" + Path.Combine(options.DataDir, "native-backend.stderr.log"), "邻传启动失败", window);
                    await StopAsync(); Environment.ExitCode = 1;
                }
            };
            application.Run(); mutex.ReleaseMutex(); return Environment.ExitCode;
        }
        catch (Exception ex) { AppDialog.Show(ex.Message, "Linchuan"); return 1; }
    }
    private static void Activate(Window window) { window.Show(); if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal; window.Activate(); }
    private static async Task ActivateAsync(string name) { using var pipe = new NamedPipeClientStream(".", name, PipeDirection.Out); using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await pipe.ConnectAsync(timeout.Token); await pipe.WriteAsync(Encoding.ASCII.GetBytes("activate\n"), timeout.Token); }
    private static async Task ListenAsync(string name, Action activate, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { using var pipe = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly); await pipe.WaitForConnectionAsync(ct); var bytes = new byte[16]; using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(2)); var length = await pipe.ReadAsync(bytes, timeout.Token); if (Encoding.ASCII.GetString(bytes, 0, length).Trim() == "activate") activate(); }
            catch (OperationCanceledException) { }
            catch (IOException) { }
        }
    }
}
