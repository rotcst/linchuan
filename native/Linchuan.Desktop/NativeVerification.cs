using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Linchuan.Desktop.Core;

namespace Linchuan.Desktop;

internal static class NativeVerification
{
    public static async Task RunAsync(MainWindow window, DesktopOptions options)
    {
        var report = options.VerifyOutput ?? throw new InvalidOperationException("Native verification output is required."); var pidFile = report + ".pid"; var directory = Path.GetDirectoryName(report)!; Directory.CreateDirectory(directory); File.WriteAllText(pidFile, Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        try { await RunCoreAsync(window, options); }
        catch (Exception ex)
        {
            try { await File.WriteAllTextAsync(report, JsonSerializer.Serialize(new { passed = false, error = ex.ToString(), packagedProcess = NativeWindowCapture.IsPackagedProcess }, new JsonSerializerOptions { WriteIndented = true })); } catch { }
            throw;
        }
    }
    private static async Task RunCoreAsync(MainWindow window, DesktopOptions options)
    {
        var watch = Stopwatch.StartNew(); var initialWorkingSetBytes = Process.GetCurrentProcess().WorkingSet64; var checks = new List<string>(); var directory = Path.GetDirectoryName(options.VerifyOutput)!; Directory.CreateDirectory(directory);
        await window.ReadyTask; if (window.Client?.Session is null) await window.JoinForVerificationAsync("Desktop QA");
        var native = window.Client!; await using var phone = new LanClient(new Uri(window.Target)); var host = await native.HostAsync(); await phone.JoinAsync(host.Code, "Phone QA", Guid.NewGuid().ToString("N")); await phone.UpdateDeviceAsync("Phone QA", DeviceType.Phone); await phone.ConnectSocketAsync();
        await WaitAsync(() => native.Devices.Any(device => device.Name == "Phone QA" && device.Online)); checks.Add("WebSocket presence: phone online");
        var composer = Find<TextBox>(window, "Composer")!; composer.Text = "Native UI → phone"; Find<Button>(window, "Send")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        await WaitAsync(() => window.Messages.Any(view => view.Message.Text == "Native UI → phone")); var sent = window.Messages.Single(view => view.Message.Text == "Native UI → phone").Message; var publicHistory = await phone.HistoryAsync(); Assert(publicHistory.Messages.Any(message => message.Id == sent.Id), "native send received by phone"); checks.Add("Real WPF Send button / deduplication");
        var incoming = await phone.SendTextAsync("all", "Phone → native"); await WaitAsync(() => window.Messages.Any(view => view.Message.Id == incoming.Id)); window.UpdateLayout(); await Task.Delay(100);
        Assert(Find<Button>(window, "Delete-" + incoming.Id) is not null, "receiver delete action"); Assert(Find<Button>(window, "Copy-" + incoming.Id) is not null, "receiver copy action");
        await window.HideMessageAsync(incoming, false); Assert(!(await native.HistoryAsync()).Messages.Any(message => message.Id == incoming.Id), "native hide"); Assert((await phone.HistoryAsync()).Messages.Any(message => message.Id == incoming.Id), "peer retains hidden message"); checks.Add("Copy + receiver-side deletion isolation");
        await window.SelectConversationAsync(phone.Session!.Device.Id); await window.SendTextAsync("Private native → phone"); await WaitAsync(() => window.Messages.Any(view => view.Message.Text == "Private native → phone"));
        var privateMessage = window.Messages.Single(view => view.Message.Text == "Private native → phone").Message; Assert((await phone.HistoryAsync(native.Session!.Device.Id)).Messages.Any(message => message.Id == privateMessage.Id), "private history");
        await using var stranger = new LanClient(new Uri(window.Target)); await stranger.JoinAsync(host.Code, "Third QA", Guid.NewGuid().ToString("N")); Assert(!(await stranger.HistoryAsync(native.Session.Device.Id)).Messages.Any(message => message.Id == privateMessage.Id), "private history ACL"); checks.Add("Private conversation / third-device ACL");
        var binary = Path.Combine(directory, "qa-chunks.bin"); var downloaded = Path.Combine(directory, "qa-downloaded.bin"); var image1 = Path.Combine(directory, "qa-photo-1.png"); var image2 = Path.Combine(directory, "qa-photo-2.png");
        try
        {
            await File.WriteAllBytesAsync(binary, RandomNumberGenerator.GetBytes(9 * 1024 * 1024 + 19)); await window.UploadFileAsync(binary); await WaitAsync(() => window.Messages.Any(view => view.Message.File?.Name == Path.GetFileName(binary))); var file = window.Messages.First(view => view.Message.File?.Name == Path.GetFileName(binary)).Message.File!; await phone.DownloadAsync(file.Id, downloaded);
            var sourceHash = SHA256.HashData(await File.ReadAllBytesAsync(binary)); var downloadHash = SHA256.HashData(await File.ReadAllBytesAsync(downloaded)); Assert(sourceHash.SequenceEqual(downloadHash), "multi-chunk download SHA256"); checks.Add("9 MiB+ multi-chunk upload and atomic download SHA256");
            var forbidden = false; try { await stranger.GetBytesAsync("api/files/" + file.Id, 12 * 1024 * 1024); } catch (HttpRequestException ex) { forbidden = ex.StatusCode == System.Net.HttpStatusCode.NotFound; }
            Assert(forbidden, "file ACL");
            Photo(image1, Colors.SteelBlue); Photo(image2, Colors.SandyBrown); await phone.UploadAsync(image1, native.Session.Device.Id); await phone.UploadAsync(image2, native.Session.Device.Id); await WaitAsync(() => window.Messages.Count(view => view.Message.File?.Mime == "image/png") >= 2);
            var photos = window.Messages.Select(view => view.Message).Where(message => message.File?.Mime == "image/png").ToArray(); var gallery = new MediaWindow(native, photos, 0) { Owner = window }; gallery.Show(); await gallery.ImageReady; await WaitAsync(() => NativeWindowCapture.HasExpectedCorners(gallery)); gallery.SetZoom(2); Assert(gallery.Zoom == 2, "gallery zoom"); gallery.Navigate(1); await gallery.ImageReady; Assert(gallery.Index == 1 && gallery.Zoom == 1, "gallery navigation resets zoom"); Screenshot(gallery, Path.Combine(directory, "native-gallery.png")); gallery.Close(); checks.Add("Authenticated PNG preview / gallery zoom and navigation");
        }
        finally { foreach (var file in new[] { binary, downloaded, image1, image2 }) if (File.Exists(file)) File.Delete(file); }
        await window.SelectConversationAsync("all");
        await VerifyConnectionEntriesAsync(window, native); checks.Add("Actual backend configured public URL + local/LAN entries / selection updates address without selecting loopback by default");
        foreach (var language in new[] { "zh", "en", "ko", "ja" }) foreach (var theme in new[] { "light", "dark" }) { window.ChangeAppearance(language, theme); window.UpdateLayout(); await Task.Delay(120); Screenshot(window, Path.Combine(directory, $"native-{language}-{theme}.png")); Assert(Find<TextBox>(window, "Composer")!.FocusVisualStyle is null, "no outer focus halo"); }
        checks.Add("Four languages × two themes / actual WPF screenshots");
        var versionLabel = Find<TextBlock>(window, "Version")!; Assert(versionLabel.Text == L.T("版本") + " " + AppVersion.Display && Find<Button>(window, "CheckUpdates") is not null, "version and update entry survive four-language theme rebuilds");
        using (var fakeUpdates = new UpdateChecker(new VerificationUpdateHandler(UpdateChecker.CurrentVersion())))
        {
            var dismiss = window.Dispatcher.BeginInvoke(new Action(() =>
            {
                var dialog = Application.Current.Windows.OfType<AppWindow>().FirstOrDefault(item => item != window && item.Title == L.T("检查更新"));
                if (dialog is not null) Find<Button>(dialog, "ConfirmAccept")?.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            }));
            await window.CheckForUpdatesAsync(fakeUpdates);
        }
        checks.Add("Update dialog uses fake latest-version response without external navigation");
        foreach (var theme in new[] { "light", "dark" })
        {
            window.ChangeAppearance("zh", theme); window.UpdateLayout(); await Task.Delay(120);
            window.Activate(); var language = Find<Button>(window, "Language")!; language.Focus(); language.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Task.Delay(120); var menu = language.ContextMenu!; menu.UpdateLayout();
            foreach (var item in menu.Items.OfType<MenuItem>()) { var flag = ((Panel)item.Header).Children.OfType<Image>().Single(); var top = flag.TranslatePoint(new Point(), item).Y; Assert(flag.ActualWidth == 22 && flag.ActualHeight == 22 && top >= 8 && top + 22 <= item.ActualHeight - 8, "uncropped language flags"); }
            var focusedLanguage = menu.Items.OfType<MenuItem>().First(); var focusAccepted = focusedLanguage.Focus(); await Task.Delay(80); Assert(focusedLanguage.IsKeyboardFocused && ((SolidColorBrush)focusedLanguage.Background).Color == ((SolidColorBrush)Ui.Brush("Selected")).Color, $"dropdown keyboard highlight uses shared theme token; focusAccepted={focusAccepted}, focused={focusedLanguage.IsKeyboardFocused}, highlighted={focusedLanguage.IsHighlighted}, background={focusedLanguage.Background}, expected={Ui.Brush("Selected")}, menuOpen={menu.IsOpen}, active={window.IsActive}");
            NativeWindowCapture.Save(menu, Path.Combine(directory, "native-language-" + theme + ".png")); menu.IsOpen = false;
            _ = window.Dispatcher.BeginInvoke(() => Find<Button>(window, "Settings")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)));
            await WaitAsync(() => Application.Current.Windows.OfType<AppWindow>().Any(dialog => dialog != window && dialog.Title == L.T("设备设置")));
            var settingsDialog = Application.Current.Windows.OfType<AppWindow>().Single(dialog => dialog != window && dialog.Title == L.T("设备设置")); await Task.Delay(120); Assert(Find<Button>(settingsDialog, "WindowMinimize")!.Visibility == Visibility.Collapsed, "dialog caption only close"); Assert(NativeWindowCapture.HasExpectedCorners(settingsDialog), "settings rounded frame"); Screenshot(settingsDialog, Path.Combine(directory, "native-settings-" + theme + ".png"));
            _ = window.Dispatcher.BeginInvoke(() => Find<Button>(settingsDialog, "SwitchHost")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)));
            await WaitAsync(() => Application.Current.Windows.OfType<AppWindow>().Any(dialog => dialog != window && dialog.Title == L.T("连接你的设备")));
            var joinDialog = Application.Current.Windows.OfType<AppWindow>().Single(dialog => dialog != window && dialog.Title == L.T("连接你的设备")); await Task.Delay(120); Assert(NativeWindowCapture.HasExpectedCorners(joinDialog), "join dialog rounded frame"); Screenshot(joinDialog, Path.Combine(directory, "native-connect-" + theme + ".png")); Find<Button>(joinDialog, "WindowClose")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            _ = window.Dispatcher.BeginInvoke(async () => await window.HideMessageAsync(sent));
            await WaitAsync(() => Application.Current.Windows.OfType<AppWindow>().Any(dialog => dialog != window && dialog.Title == L.T("仅从本设备删除")));
            var confirmation = Application.Current.Windows.OfType<AppWindow>().Single(dialog => dialog != window && dialog.Title == L.T("仅从本设备删除")); await Task.Delay(120); Assert(NativeWindowCapture.HasExpectedCorners(confirmation), "confirmation rounded frame"); Screenshot(confirmation, Path.Combine(directory, "native-confirm-" + theme + ".png")); Find<Button>(confirmation, "ConfirmCancel")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Assert((await native.HistoryAsync()).Messages.Any(message => message.Id == sent.Id), "cancel deletion retains message");
        }
        Assert(Find<Button>(window, "AddDevice") is null && Find<Button>(window, "ConnectOther") is null, "duplicate connection entry points removed"); checks.Add("Actual native captions and dialogs match theme / four uncropped round flags / single connection panel");
        Assert(NativeWindowCapture.HasExpectedCorners(window), "main window rounded frame"); Assert(NativeWindowCapture.HitTest(window, new Point(window.ActualWidth / 2, 16)) == 2, "native draggable caption hit test"); Assert(NativeWindowCapture.HitTest(window, new Point(2, window.ActualHeight / 2)) == 10, "native left resize edge hit test"); Find<Button>(window, "WindowMaximize")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Task.Delay(160); Assert(window.WindowState == WindowState.Maximized && NativeWindowCapture.HasExpectedCorners(window), "caption maximize with full rectangular work area"); Screenshot(window, Path.Combine(directory, "native-maximized.png")); Assert(NativeWindowCapture.FitsWorkArea(window, Find<Button>(window, "Send")!), "maximized composer remains within monitor work area"); Find<Button>(window, "WindowMaximize")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Task.Delay(120); Assert(window.WindowState == WindowState.Normal && NativeWindowCapture.HasExpectedCorners(window), "caption restore reinstates rounded corners"); Find<Button>(window, "WindowMinimize")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Task.Delay(120); Assert(window.WindowState == WindowState.Minimized, "caption minimize"); System.Windows.SystemCommands.RestoreWindow(window); await Task.Delay(120); checks.Add("Rounded main/media/dialog windows / maximize resets corners / restore reinstates rounding / native drag and resize hit tests");
        window.ChangeAppearance("zh", "dark"); window.Hide(); Assert((await native.InfoAsync()).ServerName == "邻传", "hide retains service"); window.Show();
        await VerifyTrayMenuAsync(window, directory); checks.Add("Themed tray popup while main window is hidden / green keyboard highlight / Escape and command callbacks");
        var settings = new SettingsStore(Path.Combine(options.ClientDir, "sessions.json")); var restored = await settings.LoadAsync(window.Target, native.Session.Device.Id); Assert(restored?.SessionToken == native.Session.Token, "DPAPI round-trip"); Assert(!File.ReadAllText(Path.Combine(options.ClientDir, "sessions.json")).Contains(native.Session.Token, StringComparison.Ordinal), "no plaintext persisted token"); checks.Add("DPAPI storage / close-to-tray retains service");
        window.UpdateLayout(); Assert(Find<Button>(window, "Theme")!.ActualHeight == 34, "theme control height"); Assert(Find<Button>(window, "Language")!.ActualHeight == 34, "language control height"); Assert(Find<Button>(window, "Settings")!.ActualHeight == 34, "settings control height"); Assert(Find<Button>(window, "ChooseFiles")!.ActualHeight == 32, "attachment icon scale"); checks.Add("Shared control heights and compact attachment icons");
        var peakWorkingSetBytes = Process.GetCurrentProcess().PeakWorkingSet64;
        var languageButton = Find<Button>(window, "Language")!; var themeButton = Find<Button>(window, "Theme")!; var connectionStatus = Find<TextBlock>(window, "ConnectionStatus")!;
        var statusGap = languageButton.TranslatePoint(new Point(), window).X - connectionStatus.TranslatePoint(new Point(connectionStatus.ActualWidth, 0), window).X; var themeGap = themeButton.TranslatePoint(new Point(), window).X - languageButton.TranslatePoint(new Point(languageButton.ActualWidth, 0), window).X;
        Assert(statusGap >= 11 && themeGap >= 11, "dynamic toolbar spacing"); Assert(Find<Button>(window, "Entry")!.HorizontalContentAlignment == HorizontalAlignment.Stretch, "entry text/arrow alignment");
        var brandTitle = Find<TextBlock>(window, "BrandTitle")!; var brandSubtitle = Find<TextBlock>(window, "BrandSubtitle")!; var brandArrows = Find<System.Windows.Shapes.Path>(window, "BrandArrows")!; var mark = (Border)brandArrows.Parent;
        var brandBottom = mark.TranslatePoint(new Point(0, mark.ActualHeight), window).Y;
        Assert(Math.Abs(brandTitle.TranslatePoint(new Point(0, brandTitle.ActualHeight), window).Y - brandBottom) < 1 && Math.Abs(brandSubtitle.TranslatePoint(new Point(0, brandSubtitle.ActualHeight), window).Y - brandBottom) < 1 && brandSubtitle.TranslatePoint(new Point(), window).X > brandTitle.TranslatePoint(new Point(brandTitle.ActualWidth, 0), window).X, "brand icon, title and subtitle bottom aligned horizontally");
        Assert(Math.Abs(brandArrows.TranslatePoint(new Point(brandArrows.ActualWidth / 2, brandArrows.ActualHeight / 2), mark).X - mark.ActualWidth / 2) < 1 && Math.Abs(brandArrows.TranslatePoint(new Point(brandArrows.ActualWidth / 2, brandArrows.ActualHeight / 2), mark).Y - mark.ActualHeight / 2) < 1, "symmetric vector arrows centered"); checks.Add("Centered vector brand arrows / horizontal bottom-aligned title and subtitle");
        var copyButton = Find<Button>(window, "CopyAddress")!; var addressRow = (DockPanel)copyButton.Parent; Assert(Math.Abs(copyButton.TranslatePoint(new Point(copyButton.ActualWidth, 0), addressRow).X - addressRow.ActualWidth) < 1, "copy button dock right"); Assert(Find<TextBox>(window, "Address")!.TextAlignment == TextAlignment.Left, "address text left alignment"); checks.Add("12px dynamic toolbar gaps / left-aligned URL and right-docked copy");
        VerifyCopy(window, Find<Button>(window, "Copy-" + sent.Id)!, sent.Text);
        VerifyCopy(window, Find<Button>(window, "CopyAddress")!, Find<TextBox>(window, "Address")!.Text);
        VerifyCopy(window, Find<Button>(window, "CopyCode")!, (await native.HostAsync()).Code);
        await Task.Delay(300); GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); await Task.Delay(200);
        await File.WriteAllTextAsync(options.VerifyOutput!, JsonSerializer.Serialize(new { passed = true, checks, elapsedMs = watch.ElapsedMilliseconds, initialWorkingSetBytes, peakWorkingSetBytes, afterQaGcWorkingSetBytes = Process.GetCurrentProcess().WorkingSet64, nativeWpf = true, browserOrWebView = false, packagedProcess = NativeWindowCapture.IsPackagedProcess }, new JsonSerializerOptions { WriteIndented = true }));
    }
    private static void Photo(string file, Color color) { var visual = new DrawingVisual(); using (var context = visual.RenderOpen()) { context.DrawRectangle(new SolidColorBrush(color), null, new Rect(0, 0, 640, 360)); } var bitmap = new RenderTargetBitmap(640, 360, 96, 96, PixelFormats.Pbgra32); bitmap.Render(visual); var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); using var stream = File.Create(file); encoder.Save(stream); }
    private sealed class VerificationUpdateHandler(Version version) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var tag = "v" + version.ToString(3); var body = JsonSerializer.Serialize(new { tag_name = tag, draft = false, prerelease = false, html_url = "https://github.com/rotcst/linchuan/releases/tag/" + tag });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") });
        }
    }
    private static async Task VerifyConnectionEntriesAsync(MainWindow window, LanClient client)
    {
        const string publicEntry = "https://transfer.example.test";
        var host = await client.HostAsync(); Assert(host.LocalUrl == new Uri(window.Target).GetLeftPart(UriPartial.Authority), "host local entry uses actual backend port"); Assert(host.PublicUrl == publicEntry && host.Internet == "disabled", "configured public origin retained without launching a tunnel");
        Assert(Find<TextBlock>(window, "HostStatus")!.Text == L.T("局域网可用 · 互联网通道未启用"), "configured offline origin is not reported as connected");
        var initial = Find<TextBox>(window, "Address")!.Text; Assert(!new Uri(initial).IsLoopback, "default share entry avoids loopback");
        var draft = Find<TextBox>(window, "Composer")!; draft.Text = "Draft survives changing the connection entry";
        var menu = Find<Button>(window, "Entry")!.ContextMenu!; menu.IsOpen = true; await Task.Delay(80);
        var entries = menu.Items.OfType<MenuItem>().Select(item => (string)item.Header).ToArray(); Assert(entries.Contains(host.LocalUrl) && entries.Contains(host.PublicUrl) && entries.Length == entries.Distinct(StringComparer.OrdinalIgnoreCase).Count(), "local/public entries are present and deduplicated");
        menu.Items.OfType<MenuItem>().Single(item => (string)item.Header == host.LocalUrl).RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent)); menu.IsOpen = false; window.UpdateLayout(); Assert(Find<TextBox>(window, "Address")!.Text == host.LocalUrl, "selected local entry updates address");
        menu = Find<Button>(window, "Entry")!.ContextMenu!; menu.IsOpen = true; await Task.Delay(80); menu.Items.OfType<MenuItem>().Single(item => (string)item.Header == publicEntry).RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent)); menu.IsOpen = false; window.UpdateLayout(); Assert(Find<TextBox>(window, "Address")!.Text == publicEntry, "selected public entry updates address"); await VerifyQrAsync(window, client, publicEntry);
        menu = Find<Button>(window, "Entry")!.ContextMenu!; menu.Items.OfType<MenuItem>().Single(item => (string)item.Header == initial).RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent)); window.UpdateLayout(); await VerifyQrAsync(window, client, initial);
        Assert(Find<TextBox>(window, "Composer") == draft && draft.Text == "Draft survives changing the connection entry", "entry selection preserves composer and draft"); draft.Clear();
    }
    private static async Task VerifyQrAsync(MainWindow window, LanClient client, string entry)
    {
        var bytes = await client.GetBytesAsync("api/qr?format=png&url=" + Uri.EscapeDataString(entry), 1024 * 1024); var expected = new FormatConvertedBitmap(Ui.Bitmap(bytes), PixelFormats.Bgra32, null, 0); var stride = expected.PixelWidth * 4; var expectedPixels = new byte[stride * expected.PixelHeight]; expected.CopyPixels(expectedPixels, stride, 0);
        await WaitAsync(() => { if (Find<Image>(window, "ConnectionQr")!.Source is not BitmapSource source || source.PixelWidth != expected.PixelWidth || source.PixelHeight != expected.PixelHeight) return false; var actual = new FormatConvertedBitmap(source, PixelFormats.Bgra32, null, 0); var pixels = new byte[expectedPixels.Length]; actual.CopyPixels(pixels, stride, 0); return pixels.SequenceEqual(expectedPixels); });
    }
    private static async Task VerifyTrayMenuAsync(MainWindow window, string directory)
    {
        var opened = 0; var exited = 0; var updates = 0; using var menu = new TrayMenu(() => { opened++; window.Show(); }, () => exited++, () => { updates++; return Task.CompletedTask; });
        try
        {
            foreach (var theme in new[] { "light", "dark" })
            {
                window.ChangeAppearance("zh", theme); window.Hide(); menu.ShowForTray(); await Task.Delay(150); menu.UpdateLayout();
                Assert(menu.IsOpen && !window.IsVisible && !menu.StaysOpen && menu.ActualWidth == Theme.Number("tray-menu-width", 156) && menu.ActualHeight < 150, "tray menu opens independently of hidden main window");
                var trayVersionItem = menu.Items.OfType<MenuItem>().Single(item => AutomationProperties.GetAutomationId(item) == "TrayVersion"); var trayVersion = (TextBlock)trayVersionItem.Header; trayVersion.UpdateLayout(); var trayVersionOrigin = trayVersion.TranslatePoint(new Point(), menu); var trayVersionRight = trayVersionOrigin.X + trayVersion.ActualWidth; Assert(trayVersion.Text.EndsWith(AppVersion.Display, StringComparison.Ordinal) && trayVersion.ActualWidth > 0 && trayVersionOrigin.X >= 0 && trayVersionRight <= menu.ActualWidth, "tray version is fully measured inside compact popup");
                var exit = menu.Items.OfType<MenuItem>().Last(); var focusAccepted = exit.Focus(); await Task.Delay(80);
                Assert(exit.IsKeyboardFocused && exit.ActualHeight == Theme.Number("tray-menu-option-height", 32), $"tray keyboard navigation and compact row size; focusAccepted={focusAccepted}, focused={exit.IsKeyboardFocused}, height={exit.ActualHeight}, expected={Theme.Number("tray-menu-option-height", 32)}, menuOpen={menu.IsOpen}");
                Assert(((SolidColorBrush)exit.Background).Color == ((SolidColorBrush)Ui.Brush("TrayActive")).Color && ((SolidColorBrush)exit.Foreground).Color == ((SolidColorBrush)Ui.Brush("TrayActiveText")).Color, "tray green highlight and readable foreground");
                var screenshot = Path.Combine(directory, "native-tray-" + theme + ".png"); NativeWindowCapture.Save(menu, screenshot);
                Assert(((SolidColorBrush)menu.Background).Color == ((SolidColorBrush)Ui.Brush("TraySurface")).Color, "tray popup surface uses current theme");
                using (var bitmap = new System.Drawing.Bitmap(screenshot)) { var expected = ((SolidColorBrush)Ui.Brush("TraySurface")).Color; var scale = VisualTreeHelper.GetDpi(menu).DpiScaleY; var actual = bitmap.GetPixel(bitmap.Width / 2, (int)(4 * scale)); Assert(actual.R == expected.R && actual.G == expected.G && actual.B == expected.B, "actual tray popup background pixels match theme"); }
                menu.RaiseEvent(new System.Windows.Input.KeyEventArgs(System.Windows.Input.Keyboard.PrimaryDevice, PresentationSource.FromVisual(menu), 0, System.Windows.Input.Key.Escape) { RoutedEvent = System.Windows.Input.Keyboard.PreviewKeyDownEvent }); Assert(!menu.IsOpen, "Escape dismisses tray menu");
            }
            var versionItem = menu.Items.OfType<MenuItem>().Single(item => AutomationProperties.GetAutomationId(item) == "TrayVersion"); var updateItem = menu.Items.OfType<MenuItem>().Single(item => AutomationProperties.GetAutomationId(item) == "TrayCheckUpdates"); Assert(versionItem.IsEnabled == false && updateItem.IsEnabled, "tray version and update commands are present");
            menu.ShowForTray(); await Task.Delay(80); updateItem.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent)); await Task.Delay(80); Assert(updates == 1 && !menu.IsOpen, "tray update command dispatched once");
            menu.ShowForTray(); await Task.Delay(80); menu.Items.OfType<MenuItem>().Single(item => AutomationProperties.GetAutomationId(item) == "TrayOpen").RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent)); Assert(opened == 1 && window.IsVisible && !menu.IsOpen, "tray open command restores main window");
            menu.ShowForTray(); await Task.Delay(80); menu.Items.OfType<MenuItem>().Last().RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent)); Assert(exited == 1 && !menu.IsOpen, "tray exit command dispatched once");
        }
        finally { menu.IsOpen = false; window.Show(); window.ChangeAppearance("zh", "dark"); }
    }
    private static void VerifyCopy(MainWindow window, Button button, string text)
    {
        var existing = Clipboard.GetDataObject(); var snapshot = new DataObject();
        if (existing is not null) foreach (var format in existing.GetFormats(false)) { var value = existing.GetData(format, false); if (value is not null) snapshot.SetData(format, value, false); }
        var actionRan = false; var actionMatched = false; var writeSequence = 0u;
        void Completed(string value) { actionRan = true; actionMatched = value == text; writeSequence = NativeWindowCapture.GetClipboardSequenceNumber(); }
        window.CopyCompleted += Completed;
        // Validate the public Windows text format independently of WPF's data-object reader.
        try { button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); var copied = NativeWindowCapture.ReadClipboardUnicode(window, writeSequence); Assert(actionRan && actionMatched && copied == text && writeSequence == NativeWindowCapture.GetClipboardSequenceNumber(), $"native CF_UNICODETEXT; actionRan={actionRan}, actionMatched={actionMatched}, expectedLength={text.Length}, actualLength={copied.Length}, externalChange={writeSequence != NativeWindowCapture.GetClipboardSequenceNumber()}"); }
        finally { window.CopyCompleted -= Completed; if (existing is null) Clipboard.Clear(); else Clipboard.SetDataObject(snapshot, true); }
    }
    public static void Screenshot(Window window, string file) { window.UpdateLayout(); NativeWindowCapture.Save(window, file, ((AppWindow)window).CaptionResource); }
    private static async Task WaitAsync(Func<bool> condition) { var deadline = DateTime.UtcNow.AddSeconds(10); while (!condition()) { if (DateTime.UtcNow > deadline) throw new TimeoutException("Native QA condition timed out."); await Task.Delay(40); } }
    private static void Assert(bool condition, string label) { if (!condition) throw new InvalidOperationException("Native QA failed: " + label); }
    private static T? Find<T>(DependencyObject root, string id) where T : FrameworkElement { if (root is T value && AutomationProperties.GetAutomationId(value) == id) return value; for (var index = 0; index < VisualTreeHelper.GetChildrenCount(root); index++) { var found = Find<T>(VisualTreeHelper.GetChild(root, index), id); if (found is not null) return found; } return null; }
}
