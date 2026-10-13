using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Linchuan.Desktop.Core;
using Microsoft.Win32;

namespace Linchuan.Desktop;

public sealed record MessageView(ChatMessage Message, MainWindow Owner);

public sealed class MainWindow : AppWindow
{
    private readonly DesktopOptions _options;
    private readonly Preferences _preferences;
    private readonly SettingsStore _settings;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _uploads = new(1, 1);
    private readonly Dictionary<string, ChatMessage> _known = [];
    private readonly ObservableCollection<MessageView> _messages = [];
    private readonly Dictionary<string, int> _unread = [];
    private readonly TaskCompletionSource _loaded = new();
    private ListBox _list = new();
    private StackPanel _devices = new();
    private TextBox _composer = new();
    private TextBlock _status = new(), _hostStatus = new(), _error = new(), _title = new(), _subtitle = new(), _code = new(), _transfer = new();
    private Button _older = new();
    private Button _cancel = new(), _entryMenu = new();
    private TextBox _address = new();
    private Image _qr = new();
    private CancellationTokenSource? _transferCancellation;
    private ServerInfo? _info;
    private HostInfo? _host;
    private string _entry = "", _conversation = "all";
    private string? _beforeId;
    private long? _before;
    private bool _exit, _busy, _loading;
    private int _generation;
    private readonly UpdateChecker _updates;
    private readonly BackendHost _backend;
    private readonly HostHandoff _handoff;
    private bool _handoffBusy;
    private LanClient? _previousHandoffClient;
    public MainWindow(DesktopOptions options, BackendHost backend, UpdateChecker? updates = null) : base(integratedCaption: true)
    {
        _updates = updates ?? new(); _options = options; _backend = backend; _preferences = Preferences.Load(options.ClientDir);
        _handoff = new HostHandoff(options.StorageRoot.Length > 0 ? options.StorageRoot : options.DataDir, options.ClientDir, options.Port, ActivateHostAsync, DemoteHostAsync, value => Dispatcher.BeginInvoke(() => { _transfer.Text = L.T(value); }));
        _handoff.Completed = async () => { var previous = _previousHandoffClient; _previousHandoffClient = null; if (previous is not null && previous != Client) await previous.DisposeAsync(); };
        Target = options.ServerUri ?? (_preferences.Server.Length > 0 ? _preferences.Server : $"http://127.0.0.1:{options.Port}");
        _settings = new SettingsStore(Path.Combine(options.ClientDir, "sessions.json"));
        L.Set(_preferences.Language); Theme.Apply(_preferences.Theme);
        Width = 1280; Height = 820; MinWidth = 860; MinHeight = 560; WindowStartupLocation = WindowStartupLocation.CenterScreen;
        SetResourceReference(Control.BackgroundProperty, "Page"); SetResourceReference(Control.ForegroundProperty, "Text"); SetResourceReference(Control.FontFamilyProperty, "Font");
        Loaded += (_, _) => _loaded.TrySetResult();
        Closing += (_, e) => { if (!_exit && _options.VerifyOutput is null) { e.Cancel = true; Hide(); } };
        AllowDrop = true;
        PreviewDragOver += (_, e) => { e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; e.Handled = true; };
        Drop += async (_, e) => { if (e.Data.GetData(DataFormats.FileDrop) is string[] paths) await RunAsync(() => UploadFilesAsync(paths)); e.Handled = true; };
        Build(); ReadyTask = InitializeAsync();
    }
    public LanClient? Client { get; private set; }
    public Task ReadyTask { get; }
    public string Target { get; private set; }
    public string Conversation => _conversation;
    public ObservableCollection<MessageView> Messages => _messages;
    public bool TransferBusy => _busy;
    internal bool HostTransferBusy => _handoffBusy;
    internal string VerificationError => _error.Text;
    internal string VerificationHandoffProgress => _transfer.Text;
    public CancellationToken Lifetime => _lifetime.Token;
    public event Action? ExitRequested;
    internal event Action<string>? CopyCompleted;
    internal Action<string> ClipboardWriter { get; set; } = Clipboard.SetText;
    private CopyFeedback? _copyFeedback;
    private void Build()
    {
        _copyFeedback?.Dispose(); _copyFeedback = new CopyFeedback(value => ClipboardWriter(value));
        Title = L.T("邻传") + " · " + L.T("设备互传");
        var root = new Grid(); root.SetResourceReference(Panel.BackgroundProperty, "Page");
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(56) }); root.RowDefinitions.Add(new RowDefinition());
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(212) }); root.ColumnDefinitions.Add(new ColumnDefinition()); root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(284) });
        var toolbar = new DockPanel { LastChildFill = false, Margin = new Thickness(18, 0, 0, 0) }; var windowControls = new AppCaption { ShowTitle = false, Height = Theme.Number("layout-header", 56) }; DockPanel.SetDock(windowControls, Dock.Right); toolbar.Children.Add(windowControls);
        var arrows = new System.Windows.Shapes.Path { Data = Geometry.Parse("M 2,6 H 22 M 17,1 L 22,6 L 17,11 M 22,18 H 2 M 7,13 L 2,18 L 7,23"), StrokeThickness = 1.8, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round, Stretch = Stretch.Uniform, Width = 20, Height = 20, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center }; arrows.SetResourceReference(System.Windows.Shapes.Shape.StrokeProperty, "OnAccent"); AutomationProperties.SetAutomationId(arrows, "BrandArrows");
        var mark = Ui.Border(arrows, "Accent", 0); mark.Width = mark.Height = Theme.Number("size-brand-mark", 34); mark.VerticalAlignment = VerticalAlignment.Bottom;
        var brandTitle = Ui.Text("邻传", Theme.Number("type-brand", 22)); brandTitle.FontWeight = FontWeights.SemiBold; brandTitle.VerticalAlignment = VerticalAlignment.Bottom; AutomationProperties.SetAutomationId(brandTitle, "BrandTitle");
        var brandSubtitle = Ui.Text("设备互传", Theme.Number("type-label", 13), "Muted"); brandSubtitle.VerticalAlignment = VerticalAlignment.Bottom; AutomationProperties.SetAutomationId(brandSubtitle, "BrandSubtitle");
        var brand = Ui.Row(mark, brandTitle, brandSubtitle); brand.Height = mark.Height; brand.VerticalAlignment = VerticalAlignment.Center; toolbar.Children.Add(brand);
        var tools = Ui.Row(); tools.Margin = new Thickness(0, 0, 16, 0); System.Windows.Shell.WindowChrome.SetIsHitTestVisibleInChrome(tools, true); DockPanel.SetDock(tools, Dock.Right); _status = Ui.Text(Client?.Session is null ? "正在连接…" : "已连接", 12, "Muted"); AutomationProperties.SetAutomationId(_status, "ConnectionStatus"); tools.Children.Add(_status);
        var language = Ui.Menu("", new[] { ("简体中文", "zh"), ("English", "en"), ("한국어", "ko"), ("日本語", "ja") }.Select(item => (item.Item1, (Action)(() => ChangeAppearance(item.Item2, null)))), "Language"); language.Content = Ui.Row(Ui.Flag(L.Language), Ui.Text("⌄", 13, "Muted")); tools.Children.Add(language);
        tools.Children.Add(Ui.Menu(_preferences.Theme switch { "light" => "浅色", "dark" => "深色", _ => "跟随系统" }, new[] { ("跟随系统", "system"), ("浅色", "light"), ("深色", "dark") }.Select(item => (item.Item1, (Action)(() => ChangeAppearance(null, item.Item2)))), "Theme")); toolbar.Children.Add(tools);
        var top = Ui.Border(toolbar, "Rail", 0, 0); Grid.SetColumnSpan(top, 3); root.Children.Add(top);
        var rail = new DockPanel { Margin = new Thickness(10, 16, 10, 12) }; var bottom = new StackPanel(); DockPanel.SetDock(bottom, Dock.Bottom);
        foreach (var (label, iconKey, action, id) in new[] { ("设备设置", "settings", (Action)ShowSettings, "Settings"), ("退出邻传", "exit", (Action)RequestExit, "Quit") }) { var button = Ui.Button("", action, id); button.Content = Ui.Row(Ui.Icon(iconKey), Ui.Text(label, 13)); button.HorizontalContentAlignment = HorizontalAlignment.Left; button.BorderThickness = new Thickness(0); button.Margin = new Thickness(0, 4, 0, 4); button.SetResourceReference(Control.BackgroundProperty, "Rail"); bottom.Children.Add(button); }
        var version = Ui.Text(L.T("版本") + " " + AppVersion.Display, 10, "Muted"); AutomationProperties.SetAutomationId(version, "Version"); version.Margin = new Thickness(8, 4, 0, 2); bottom.Children.Add(version);
        var updates = Ui.AsyncButton("检查更新", () => CheckForUpdatesAsync(), "CheckUpdates"); updates.Height = 28; updates.HorizontalContentAlignment = HorizontalAlignment.Left; updates.BorderThickness = new Thickness(0); updates.Margin = new Thickness(0, 0, 0, 2); updates.SetResourceReference(Control.BackgroundProperty, "Rail"); bottom.Children.Add(updates);
        rail.Children.Add(bottom);
        var caption = Ui.Text("在线设备", 12, "Muted"); caption.Margin = new Thickness(8, 0, 0, 12); DockPanel.SetDock(caption, Dock.Top); rail.Children.Add(caption);
        _devices = new StackPanel(); rail.Children.Add(new ScrollViewer { Content = _devices, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled });
        var railFrame = Ui.Border(rail, "Rail", 0, 0); Grid.SetRow(railFrame, 1); root.Children.Add(railFrame);
        var chat = new Grid(); chat.SetResourceReference(Panel.BackgroundProperty, "Surface"); chat.RowDefinitions.Add(new RowDefinition { Height = new GridLength(72) }); chat.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); chat.RowDefinitions.Add(new RowDefinition()); chat.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var heading = new DockPanel { Margin = new Thickness(20, 0, 16, 0) };
        _title = Ui.Text("公共聊天室", 20); _title.FontWeight = FontWeights.SemiBold; _subtitle = Ui.Text("发给所有在线设备", 12, "Muted"); var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(14, 0, 0, 0) }; names.Children.Add(_title); names.Children.Add(_subtitle); var icon = Ui.Icon("chat"); icon.SetResourceReference(TextBlock.ForegroundProperty, "Accent"); DockPanel.SetDock(icon, Dock.Left); heading.Children.Add(icon); heading.Children.Add(names); chat.Children.Add(Ui.Border(heading, "Surface", 0, 0));
        _older = Ui.AsyncButton("查看更早的消息", () => RunAsync(() => LoadHistoryAsync(true)), "LoadOlder"); _older.Visibility = Visibility.Collapsed; _older.Margin = new Thickness(16, 4, 16, 4); Grid.SetRow(_older, 1); chat.Children.Add(_older);
        _list = new ListBox { ItemsSource = _messages, BorderThickness = new Thickness(0), Margin = new Thickness(16, 0, 16, 0), HorizontalContentAlignment = HorizontalAlignment.Stretch, FocusVisualStyle = null };
        _list.SetResourceReference(Control.BackgroundProperty, "Surface"); ScrollViewer.SetHorizontalScrollBarVisibility(_list, ScrollBarVisibility.Disabled); ScrollViewer.SetCanContentScroll(_list, true); VirtualizingPanel.SetIsVirtualizing(_list, true); VirtualizingPanel.SetVirtualizationMode(_list, VirtualizationMode.Recycling);
        var itemStyle = new Style(typeof(ListBoxItem)); itemStyle.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(0))); itemStyle.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(0))); itemStyle.Setters.Add(new Setter(Control.HorizontalContentAlignmentProperty, HorizontalAlignment.Stretch)); itemStyle.Setters.Add(new Setter(Control.FocusVisualStyleProperty, null)); itemStyle.Setters.Add(new Setter(Control.TemplateProperty, new ControlTemplate(typeof(ListBoxItem)) { VisualTree = new FrameworkElementFactory(typeof(ContentPresenter)) })); _list.ItemContainerStyle = itemStyle;
        var factory = new FrameworkElementFactory(typeof(MessageCard)); factory.SetBinding(MessageCard.ModelProperty, new System.Windows.Data.Binding()); _list.ItemTemplate = new DataTemplate { VisualTree = factory }; Grid.SetRow(_list, 2); chat.Children.Add(_list);
        var composer = new Grid { Margin = new Thickness(12) }; composer.RowDefinitions.Add(new RowDefinition()); composer.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); composer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); composer.ColumnDefinitions.Add(new ColumnDefinition()); composer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var attach = Ui.Button("", () => ChooseFiles(false), "ChooseFiles"); attach.Content = Ui.Icon("attach"); attach.ToolTip = L.T("选择文件"); var photo = Ui.Button("", () => ChooseFiles(true), "ChooseMedia"); photo.Content = Ui.Icon("image"); photo.ToolTip = L.T("选择照片或视频"); foreach (var button in new[] { attach, photo }) { button.Width = button.Height = 32; button.Padding = new Thickness(4); button.BorderThickness = new Thickness(0); button.SetResourceReference(Control.BackgroundProperty, "Surface"); }
        composer.Children.Add(Ui.Row(attach, photo));
        _composer = Ui.Input("", "Composer", true); _composer.MinHeight = 48; _composer.MaxHeight = 144; _composer.BorderThickness = new Thickness(0); _composer.SetResourceReference(Control.BackgroundProperty, "Surface"); _composer.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _composer.PreviewKeyDown += async (_, e) => { if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0) { e.Handled = true; await RunAsync(() => SendTextAsync(_composer.Text)); } };
        DataObject.AddPastingHandler(_composer, async (_, e) => { if (e.DataObject.GetDataPresent(DataFormats.FileDrop)) { e.CancelCommand(); await RunAsync(() => UploadFilesAsync((string[])e.DataObject.GetData(DataFormats.FileDrop)!)); } else if (e.DataObject.GetDataPresent(DataFormats.Bitmap)) { e.CancelCommand(); await RunAsync(PasteImageAsync); } });
        var input = new Grid(); input.Children.Add(_composer); var placeholder = Ui.Text("输入消息，或把文件拖到这里", 14, "Muted"); placeholder.IsHitTestVisible = false; placeholder.Margin = new Thickness(10, 0, 10, 0); input.Children.Add(placeholder); _composer.TextChanged += (_, _) => placeholder.Visibility = _composer.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed; Grid.SetColumn(input, 1); composer.Children.Add(input);
        var send = Ui.AsyncButton("发送", () => RunAsync(() => SendTextAsync(_composer.Text)), "Send", true); send.Margin = new Thickness(8, 4, 0, 4); Grid.SetColumn(send, 2); composer.Children.Add(send);
        var hint = Ui.Text("Enter 发送 · Shift + Enter 换行", 11, "Muted"); hint.HorizontalAlignment = HorizontalAlignment.Right; Grid.SetRow(hint, 1); Grid.SetColumnSpan(hint, 3); composer.Children.Add(hint); var composerFrame = Ui.Border(composer, "Surface", 0); composerFrame.Margin = new Thickness(16, 10, 16, 16); Grid.SetRow(composerFrame, 3); chat.Children.Add(composerFrame); Grid.SetColumn(chat, 1); Grid.SetRow(chat, 1); root.Children.Add(chat);
        var side = Ui.Border(new ScrollViewer { Content = BuildInspector(), VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled }, "Rail", 18, 0); Grid.SetRow(side, 1); Grid.SetColumn(side, 2); root.Children.Add(side);
        _error = Ui.Text("", 12, "Danger"); _error.Margin = new Thickness(18, 8, 18, 8); _error.Visibility = Visibility.Collapsed; Grid.SetRow(_error, 1); Grid.SetColumn(_error, 1); _error.VerticalAlignment = VerticalAlignment.Top; Panel.SetZIndex(_error, 4); root.Children.Add(_error);
        Grid.SetRow(_copyFeedback.View, 2); Panel.SetZIndex(_copyFeedback.View, 5); chat.Children.Add(_copyFeedback.View);
        Content = root; RenderDevices(); UpdateHeading();
    }
    private StackPanel BuildInspector()
    {
        var panel = new StackPanel(); var title = Ui.Text("连接设备", 20); title.FontWeight = FontWeights.SemiBold; panel.Children.Add(title); var subtitle = Ui.Text("扫码或输入地址加入", 12, "Muted"); subtitle.Margin = new Thickness(0, 4, 0, 8); panel.Children.Add(subtitle);
        _hostStatus = Ui.Text(GetHostStatusText(), 12, "Muted"); AutomationProperties.SetAutomationId(_hostStatus, "HostStatus"); _hostStatus.Margin = new Thickness(0, 0, 0, 16); panel.Children.Add(_hostStatus);
        if (_host is not null)
        {
            panel.Children.Add(Ui.Text("这台电脑的连接码", 12, "Muted")); _code = Ui.Text(_host.Code, 38); _code.FontFamily = new FontFamily("Cascadia Code"); _code.FontWeight = FontWeights.Bold; _code.Margin = new Thickness(0, 8, 0, 6); panel.Children.Add(_code);
            panel.Children.Add(Ui.Row(CreateCopyButton("复制连接码", () => _host?.Code ?? "", "CopyCode", "连接码已复制"), Ui.AsyncButton("刷新连接码", () => RunAsync(async () => { var client = Client!; var updated = await client.RefreshCodeAsync(Lifetime); if (Client != client) return; _host ??= updated; _host.Code = updated.Code; _host.JoinLocked = updated.JoinLocked; _code.Text = updated.Code; }), "RefreshCode")));
        }
        _qr = new Image { Width = 144, Height = 144, Margin = new Thickness(0, 24, 0, 20), Stretch = Stretch.Uniform }; AutomationProperties.SetAutomationId(_qr, "ConnectionQr"); panel.Children.Add(_qr);
        var urls = (_host?.LocalUrl is { Length: > 0 } local ? [local] : Array.Empty<string>())
            .Concat(_info?.Urls ?? [])
            .Concat(_host?.PublicUrl is { Length: > 0 } hostPublic ? [hostPublic] : Array.Empty<string>())
            .Concat(_info?.PublicUrl is { Length: > 0 } value ? [value] : Array.Empty<string>())
            .Where(url => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (!urls.Contains(_entry, StringComparer.OrdinalIgnoreCase) && urls.Length > 0)
            _entry = urls.FirstOrDefault(url => !IsLoopbackUrl(url)) ?? Target;
        panel.Children.Add(Ui.Text("选择连接入口", 12, "Muted")); var menu = Ui.Menu(_entry, urls.Select(url => (url, (Action)(() => SelectConnectionEntry(url)))), "Entry"); _entryMenu = menu; menu.Margin = new Thickness(0, 6, 0, 8); panel.Children.Add(menu);
        var address = Ui.Input(_entry, "Address"); _address = address; address.IsReadOnly = true; address.Height = 34; address.BorderThickness = new Thickness(0); var copy = CreateCopyButton("", () => _entry, "CopyAddress", "地址已复制"); copy.Content = Ui.Icon("copy"); copy.Width = 34; copy.Padding = new Thickness(4); copy.BorderThickness = new Thickness(0); copy.ToolTip = L.T("复制地址"); var addressRow = new DockPanel(); DockPanel.SetDock(copy, Dock.Right); addressRow.Children.Add(copy); addressRow.Children.Add(address); var addressFrame = Ui.Border(addressRow, "Field", 0); addressFrame.Margin = new Thickness(0, 8, 0, 0); panel.Children.Add(addressFrame);
        var instructions = Ui.Text("手机扫描二维码，电脑输入上面的地址。", 12, "Muted"); instructions.Margin = new Thickness(0, 16, 0, 4); panel.Children.Add(instructions); panel.Children.Add(Ui.Text("再输入服务电脑页面上的 6 位连接码。", 12, "Muted"));
        var persistent = Ui.Text("文件与聊天持久保存", 13); persistent.Margin = new Thickness(0, 26, 0, 5); panel.Children.Add(persistent); panel.Children.Add(Ui.Text("保存在服务电脑，重启后保留。", 12, "Muted")); panel.Children.Add(Ui.Text("删除聊天记录仅影响本设备。", 12, "Muted"));
        _transfer = Ui.Text("", 12, "Muted"); _transfer.Margin = new Thickness(0, 20, 0, 8); panel.Children.Add(_transfer); _cancel = Ui.Button("取消", () => _transferCancellation?.Cancel(), "CancelTransfer"); _cancel.Visibility = _busy ? Visibility.Visible : Visibility.Collapsed; panel.Children.Add(_cancel); return panel;
    }
    private void SelectConnectionEntry(string entry)
    {
        _entry = entry; _address.Text = entry;
        if (_entryMenu.Content is Grid trigger && trigger.Children[0] is TextBlock label) label.Text = entry;
        _entryMenu.ContextMenu!.IsOpen = false; _ = RefreshQrAsync();
    }
    internal async Task CheckForUpdatesAsync(UpdateChecker? checker = null)
    {
        try
        {
            var result = await (checker ?? _updates).CheckAsync(Lifetime);
            var message = result.Status switch
            {
                UpdateStatus.UpdateAvailable => L.T("发现新版本") + " " + result.LatestVersion + "\n" + L.T("将打开官方 GitHub 发布页面。"),
                UpdateStatus.NoUpdate => L.T("当前已是最新正式版。"),
                UpdateStatus.PreviewAhead => L.T("当前预览版本高于最新正式版。"),
                UpdateStatus.NoRelease => L.T("暂时没有可用的正式发布版本。"),
                _ => L.T("检查更新失败，请稍后重试。"),
            };
            if (result.Status == UpdateStatus.UpdateAvailable && result.ReleaseUrl is not null)
            {
                if (AppDialog.Show(message, L.T("检查更新"), this, confirm: true)) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(result.ReleaseUrl.AbsoluteUri) { UseShellExecute = true });
            }
            else AppDialog.Show(message, L.T("检查更新"), this);
        }
        catch (OperationCanceledException) when (Lifetime.IsCancellationRequested) { }
        catch (Exception ex) { AppDialog.Show(L.T("检查更新失败，请稍后重试。"), L.T("检查更新"), this); System.Diagnostics.Debug.WriteLine(ex); }
    }
    private static bool IsLoopbackUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return false;
        return uri.IsLoopback || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase);
    }
    private string GetHostStatusText()
    {
        if (_host is null && Client?.Session is not null) return L.T("当前连接") + " · " + L.T(ConnectionLabel(Client));
        var configured = (_host?.PublicUrl ?? _info?.PublicUrl) is { Length: > 0 };
        return _host?.Internet switch
        {
            "connected" when configured => L.T("后台运行中 · 互联网通道已连接"),
            "connecting" or "reconnecting" when configured => L.T("后台运行中 · 互联网通道连接中…"),
            "error" when configured => L.T("局域网可用 · 互联网通道连接失败"),
            "disabled" when configured => L.T("局域网可用 · 互联网通道未启用"),
            _ => L.T("后台运行中 · 局域网可用"),
        };
    }
    private void RefreshHostStatus()
    {
        if (_hostStatus is not null) _hostStatus.Text = GetHostStatusText();
        if (_host is not null) _code.Text = _host.Code;
    }
    private async Task RefreshHostStatusAsync()
    {
        while (!_lifetime.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(5), Lifetime); } catch (OperationCanceledException) { break; }
            var client = Client;
            if (client is null) continue;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(Lifetime); timeout.CancelAfter(TimeSpan.FromSeconds(3));
                var host = await client.HostAsync(timeout.Token);
                if (Client != client) continue;
                _host = host; RefreshHostStatus();
            }
            catch (OperationCanceledException) when (Lifetime.IsCancellationRequested) { break; }
            catch (OperationCanceledException) { }
            catch (HttpRequestException) { if (Client == client) { _host = null; RefreshHostStatus(); } }
        }
    }
    private async Task InitializeAsync()
    {
        await _loaded.Task;
        try
        {
            SetClient(Target);
            var pending = await _handoff.LoadPendingAsync(Lifetime);
            if (_preferences.DeviceId.Length > 0 && _preferences.Server == Target)
            {
                var saved = await _settings.LoadAsync(Target, _preferences.DeviceId, Lifetime);
                if (saved?.Network is not null) Client!.UseNetwork(saved.Network);
                if (saved?.SessionToken is { Length: > 0 } token)
                {
                    if (pending is not null) await Client!.RestoreHandoffControlAsync(token, pending.Outgoing || _preferences.Hosting == true ? new Uri(Target) : new Uri(pending.Source), Lifetime);
                    else await Client!.RestoreAsync(token, Lifetime);
                }
            }
            if (pending is not null && Client!.Session is not null)
            {
                if (_preferences.Hosting == true && !pending.Outgoing)
                {
                    Client.UseNetwork(await Client.HandoffApiAsync<GroupNetwork>("api/network", ct: Lifetime, host: true)); _host = await Client.HostAsync(Lifetime); _info = await Client.InfoAsync(Lifetime);
                    if (Client.Network?.HostGeneration == pending.Offer.Generation && Client.Network.HostDeviceId == Client.Session.Device.Id && string.Equals(Path.GetFullPath(_options.DataDir), Path.GetFullPath(pending.DataDir), StringComparison.OrdinalIgnoreCase)) { await CompleteJoinAsync(); return; }
                }
                Build(); await _handoff.CheckIncomingAsync(Client, Lifetime);
                if (await _handoff.LoadPendingAsync(Lifetime) is null && Client.Session is not null && _info is not null) return;
            }
            _info = await Client!.InfoAsync(Lifetime);
            try { _host = await Client.HostAsync(Lifetime); } catch (HttpRequestException) { }
            Build(); _ = RefreshHostStatusAsync(); await RefreshQrAsync();
            if (Client.Session is not null) await CompleteJoinAsync(); else if (_options.VerifyOutput is null) ShowJoin();
        }
        catch (Exception ex) { ShowError(ex); if (_options.VerifyOutput is null) ShowJoin(); else throw; }
    }
    private void SetClient(string address)
    {
        var client = new LanClient(new Uri(address)); Client = client; Target = address;
        client.RouteChanged += _ => Dispatcher.BeginInvoke(() => { if (Client == client) _status.Text = L.T(ConnectionLabel(client)); });
        client.HostMoved += _ => Dispatcher.BeginInvoke(() => { if (Client == client) RenderDevices(); });
        client.PresenceChanged += _ => Dispatcher.BeginInvoke(() => { if (Client == client) RenderDevices(); });
        client.MessageReceived += message => Dispatcher.BeginInvoke(() => { if (Client != client || !_known.TryAdd(message.Id, message)) return; if (Matches(message)) AddVisible(message, true); else { var key = message.From == client.Session?.Device.Id ? message.To : message.From; _unread[key] = _unread.GetValueOrDefault(key) + 1; RenderDevices(); } });
        client.MessageHidden += id => Dispatcher.BeginInvoke(() => { if (Client != client) return; _known.Remove(id); var item = _messages.FirstOrDefault(view => view.Message.Id == id); if (item is not null) _messages.Remove(item); });
        client.ConnectionChanged += state => Dispatcher.BeginInvoke(() => { if (Client != client) return; _status.Text = L.T(state == "connected" ? ConnectionLabel(client) : "连接中断，正在重连…"); if (state == "connected" && client.Session is not null && !_loading) _ = RunAsync(() => LoadHistoryAsync(false)); });
    }
    private static string ConnectionLabel(LanClient client) => client.Network is null ? "已连接" : client.ActiveUri.IsLoopback ? "本机连接" : NetworkRoutes.IsPrivateLan(client.ActiveUri.AbsoluteUri) ? "局域网连接" : "互联网连接";
    private void ShowJoin()
    {
        var dialog = Dialog("连接你的设备"); var panel = new StackPanel { Margin = new Thickness(24) }; panel.Children.Add(Ui.Text("连接你的设备", 22));
        panel.Children.Add(Ui.Text("连接地址", 12, "Muted")); var address = Ui.Input(Target, "JoinAddress"); address.Margin = new Thickness(0, 6, 0, 12); panel.Children.Add(address);
        panel.Children.Add(Ui.Text("设备名称", 12, "Muted")); var name = Ui.Input(Environment.MachineName, "JoinName"); name.MaxLength = 30; name.Margin = new Thickness(0, 6, 0, 12); panel.Children.Add(name);
        panel.Children.Add(Ui.Text("6 位连接码", 12, "Muted")); var code = Ui.Input(_host?.Code ?? "", "JoinCode"); code.MaxLength = 6; code.Margin = new Thickness(0, 6, 0, 12); panel.Children.Add(code);
        var choices = new StackPanel(); panel.Children.Add(choices); string? selected = null;
        dialog.Loaded += async (_, _) => { if (_host is null) return; try { var devices = await Client!.HostDevicesAsync(Lifetime); if (devices.Count == 0) return; var menu = Ui.Menu("新建桌面设备", devices.Select(device => (device.Name, (Action)(() => { selected = device.Id; name.Text = device.Name; }))).Prepend(("新建桌面设备", (Action)(() => { selected = null; name.Text = Environment.MachineName; }))), "ExistingIdentity"); choices.Children.Add(Ui.Text("沿用本机旧设备身份，可保留私聊记录。", 12, "Muted")); choices.Children.Add(menu); } catch (HttpRequestException) { } };
        var error = Ui.Text("", 12, "Danger"); panel.Children.Add(error);
        panel.Children.Add(Ui.AsyncButton("进入聊天室", async () =>
        {
            try
            {
                if (!Uri.TryCreate(address.Text.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0) throw new ArgumentException(L.T("请填写有效的连接地址。"));
                var target = uri.GetLeftPart(UriPartial.Authority); if (Target != target) { if (Client is not null) await Client.DisposeAsync(); _host = null; _known.Clear(); _messages.Clear(); _entry = ""; SetClient(target); }
                _info = await Client!.InfoAsync(Lifetime); if (selected is not null && _host is not null) await Client.ClaimDesktopAsync(selected, code.Text.Trim(), Lifetime); else await Client.JoinAsync(code.Text.Trim(), name.Text.Trim(), Guid.NewGuid().ToString("N"), Lifetime);
                await CompleteJoinAsync(); dialog.Close();
            }
            catch (Exception ex) { error.Text = L.T(ex.Message); }
        }, "Join", true)); dialog.Content = panel; dialog.ShowDialog();
    }
    public async Task JoinForVerificationAsync(string name) { _host ??= await Client!.HostAsync(Lifetime); await Client!.JoinAsync(_host.Code, name, Guid.NewGuid().ToString("N"), Lifetime); await CompleteJoinAsync(); }
    internal async Task JoinRemoteForVerificationAsync(string code, string name) { await Client!.JoinAsync(code, name, Guid.NewGuid().ToString("N"), Lifetime); await CompleteJoinAsync(); }
    internal Task AdvertiseForVerificationAsync() => _handoff.AdvertiseAsync(Client!, Lifetime);
    internal Task ReceiveHandoffForVerificationAsync() => _handoff.CheckIncomingAsync(Client!, Lifetime);
    private async Task CompleteJoinAsync(string? hostDataDir = null, int? hostPort = null, GroupNetwork? expectedNetwork = null)
    {
        try { _host = await Client!.HostAsync(Lifetime); } catch (HttpRequestException) { _host = null; }
        if (_host is not null && _info?.DesktopApi >= 3) await Client!.HandoffApiAsync<System.Text.Json.JsonElement>("api/host/owner", new { deviceId = Client.Session!.Device.Id }, true, Lifetime);
        await Client!.RefreshNetworkAsync(Lifetime);
        if (expectedNetwork is not null)
        {
            var actual = Client.Network;
            if (_host is null || _info?.GroupId != expectedNetwork.GroupId || _info.HostGeneration != expectedNetwork.HostGeneration || actual?.GroupId != expectedNetwork.GroupId || actual.PublicKey != expectedNetwork.PublicKey || actual.HostGeneration != expectedNetwork.HostGeneration || actual.HostDeviceId != expectedNetwork.HostDeviceId) throw new System.IO.InvalidDataException("设备组身份不一致。");
            if (_info.PublicUrl != expectedNetwork.PublicUrl || _host.PublicUrl != expectedNetwork.PublicUrl || actual.PublicUrl != expectedNetwork.PublicUrl) throw new System.IO.InvalidDataException("公网通道地址与设备组不一致。");
        }
        Build(); await Client.ConnectSocketAsync(Lifetime); await LoadHistoryAsync(false); await RefreshQrAsync();
        if (Client.Network is not null && _options.VerifyOutput is null) await _handoff.AdvertiseAsync(Client, Lifetime);
        // Persist the role only after the target, session and connection have been verified.
        var dataDir = hostDataDir ?? _options.DataDir; var port = hostPort ?? _options.Port; var session = Client.Session!;
        await _settings.SaveAsync(new DesktopSettings { ServerUri = Target, DeviceId = session.Device.Id, Name = session.Device.Name, SessionToken = session.Token, Network = Client.Network, AppDir = _options.AppDir, DataDir = dataDir, Port = port }, Lifetime);
        var updated = new Preferences { Server = Target, DeviceId = session.Device.Id, Hosting = _host is not null, HostDataDir = _host is not null ? dataDir : _preferences.HostDataDir, HostPort = _host is not null ? port : _preferences.HostPort, Language = _preferences.Language, Theme = _preferences.Theme }; updated.Save(_options.ClientDir);
        _options.DataDir = dataDir; _options.Port = port; _preferences.Server = updated.Server; _preferences.DeviceId = updated.DeviceId; _preferences.Hosting = updated.Hosting; _preferences.HostDataDir = updated.HostDataDir; _preferences.HostPort = updated.HostPort;
        if (_host is null) await _backend.DisposeAsync();
        if (Client.Network is not null && _options.VerifyOutput is null) _ = MonitorHandoffAsync();
    }
    private bool Matches(ChatMessage message) => _conversation == "all" ? message.To == "all" : message.To != "all" && (message.From == _conversation || message.To == _conversation);
    public async Task SelectConversationAsync(string id) { _conversation = id; _unread.Remove(id); UpdateHeading(); RenderDevices(); await LoadHistoryAsync(false); }
    public void SelectConversation(string id) => _ = RunAsync(() => SelectConversationAsync(id));
    private void UpdateHeading() { var device = Client?.Devices.FirstOrDefault(item => item.Id == _conversation); _title.Text = _conversation == "all" ? L.T("公共聊天室") : device?.Name ?? L.T("设备私聊"); _subtitle.Text = L.T(_conversation == "all" ? "发给所有在线设备" : device?.Online == true ? "设备私聊 · 在线" : "设备私聊 · 对方离线，可留言"); }
    private void RenderDevices()
    {
        _devices.Children.Clear(); AddDevice("all", L.T("公共聊天室"), L.T("发给所有在线设备"), "chat", true);
        foreach (var device in Client?.Devices.OrderByDescending(item => item.Online).ThenBy(item => item.Name) ?? Enumerable.Empty<Device>()) AddDevice(device.Id, device.Name, L.T(device.Id == Client!.Network?.HostDeviceId ? "服务主机" : device.Id == Client!.Session?.Device.Id ? "本机" : device.Online ? "在线" : "离线 · 可留言"), device.Type == DeviceType.Computer ? "computer" : "phone", device.Online); UpdateHeading();
    }
    private void AddDevice(string id, string name, string detail, string icon, bool online)
    {
        var labels = new StackPanel { Width = 112 }; var title = Ui.Text(name, 13); title.TextTrimming = TextTrimming.CharacterEllipsis; title.TextWrapping = TextWrapping.NoWrap; labels.Children.Add(title); labels.Children.Add(Ui.Text(detail, 11, "Muted")); var badge = _unread.GetValueOrDefault(id) > 0 ? _unread[id].ToString(System.Globalization.CultureInfo.InvariantCulture) : online ? "●" : "○";
        var button = Ui.Button("", () => SelectConversation(id), "Device-" + id); button.Content = Ui.Row(Ui.Icon(icon), labels, Ui.Text(badge, 10, online ? "Accent" : "Offline")); button.Height = 50; button.Padding = new Thickness(8); button.Margin = new Thickness(0, 0, 0, 7); button.SetResourceReference(Control.BackgroundProperty, _conversation == id ? "Selected" : "Rail"); _devices.Children.Add(button);
        var device = Client?.Devices.FirstOrDefault(x => x.Id == id);
        if (_host is not null && device is { Type: DeviceType.Computer } && id != Client?.Session?.Device.Id)
        {
            var menu = new ContextMenu(); var transfer = new MenuItem { Header = L.T("转移服务主机"), IsEnabled = online && device.CanHostVersion is not null && !_handoffBusy && !_busy };
            transfer.ToolTip = L.T(device.CanHostVersion is null ? "目标电脑需要运行 1.2.0 或更新版本。" : "完整移交聊天、文件、设备身份和公网通道。");
            transfer.Click += async (_, _) => await RunAsync(() => TransferHostAsync(id)); menu.Items.Add(transfer); button.ContextMenu = menu;
        }
    }
    private async Task MonitorHandoffAsync()
    {
        var client = Client!;
        while (!Lifetime.IsCancellationRequested && Client == client)
        {
            try { await Task.Delay(3000, Lifetime); if (Client != client) break; await _handoff.CheckIncomingAsync(client, Lifetime); if (!_handoffBusy && Client == client) await _handoff.AdvertiseAsync(client, Lifetime); }
            catch (OperationCanceledException) when (Lifetime.IsCancellationRequested) { break; }
            catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException or InvalidOperationException) { if (Client == client) _transfer.Text = L.T(ex.Message); }
        }
    }
    public async Task TransferHostAsync(string deviceId)
    {
        if (_handoffBusy || _busy) throw new InvalidOperationException(L.T("仍有活动传输，暂不能移交。"));
        _handoffBusy = true; RenderDevices();
        try { await _handoff.TransferAsync(Client!, deviceId, _options.DataDir, Lifetime); }
        finally { _handoffBusy = false; RenderDevices(); }
    }
    private async Task ActivateHostAsync(HandoffPending pending)
    {
        var old = Client!; var session = old.Session!;
        var address = $"http://127.0.0.1:{pending.Offer.ReceivePort}";
        if (_host is not null && string.Equals(Path.GetFullPath(_options.DataDir), Path.GetFullPath(pending.DataDir), StringComparison.OrdinalIgnoreCase) && old.Network?.HostGeneration == pending.Offer.Generation && old.Network.HostDeviceId == session.Device.Id) return;
        var expected = new GroupNetwork { Protocol = old.Network!.Protocol, GroupId = old.Network.GroupId, PublicKey = old.Network.PublicKey, HostGeneration = pending.Offer.Generation, HostDeviceId = session.Device.Id, PublicUrl = old.Network.PublicUrl };
        HostHandoff.ValidatePublicConfiguration(pending.DataDir, expected.PublicUrl);
        var started = await _backend.StartAsync(_options.AppDir, pending.DataDir, pending.Offer.ReceivePort, _options.LocalOnly, Lifetime, expected);
        var previousTarget = Target; var previousInfo = _info; var previousHost = _host; var previousEntry = _entry;
        try
        {
            _previousHandoffClient = old;
            SetClient(address); Client!.UseNetwork(old.Network!); if (await Client.RestoreAsync(session.Token, Lifetime) is null) throw new System.IO.InvalidDataException("设备组身份不一致。");
            _info = await Client.InfoAsync(Lifetime); _host = await Client.HostAsync(Lifetime); _entry = "";
            await CompleteJoinAsync(pending.DataDir, pending.Offer.ReceivePort, expected);
        }
        catch
        {
            var failed = Client; Client = old; Target = previousTarget; _info = previousInfo; _host = previousHost; _entry = previousEntry; _previousHandoffClient = null;
            if (failed is not null && failed != old) await failed.DisposeAsync(); if (started) await _backend.DisposeAsync(); Build(); throw;
        }
        // The handoff controller still needs the old authenticated client for the final activation acknowledgement.
    }
    private async Task DemoteHostAsync(GroupNetwork network)
    {
        var old = Client!; var session = old.Session!; var address = network.LanUrls.FirstOrDefault(value => NetworkRoutes.IsPrivateLan(value) && new Uri(value).Scheme == "https") ?? network.PublicUrl ?? throw new InvalidDataException("新主机没有可用连接入口。");
        var previousTarget = Target; var previousInfo = _info; var previousHost = _host; var previousEntry = _entry;
        try
        {
            SetClient(address); Client!.UseNetwork(network); if (await Client.RestoreAsync(session.Token, Lifetime) is null) throw new System.IO.InvalidDataException("设备组身份不一致。");
            _info = await Client.InfoAsync(Lifetime); _host = null; _entry = ""; await CompleteJoinAsync();
        }
        catch
        {
            var failed = Client; Client = old; Target = previousTarget; _info = previousInfo; _host = previousHost; _entry = previousEntry;
            if (failed is not null && failed != old) await failed.DisposeAsync(); Build(); throw;
        }
        await old.DisposeAsync();
    }
    public async Task LoadHistoryAsync(bool older = false)
    {
        if (Client?.Session is null) return; var generation = ++_generation; var conversation = _conversation; _loading = true;
        try { var page = await Client.HistoryAsync(conversation, older ? _beforeId : null, older ? _before : null, Lifetime); if (generation != _generation || conversation != _conversation) return; if (!older) _messages.Clear(); foreach (var message in page.Messages.OrderBy(item => item.CreatedAt).ThenBy(item => item.Id)) { _known[message.Id] = message; AddVisible(message, false); } var ordered = _messages.OrderBy(view => view.Message.CreatedAt).ThenBy(view => view.Message.Id).ToArray(); _messages.Clear(); foreach (var view in ordered) _messages.Add(view); _before = page.Before; _beforeId = page.BeforeId; _older.Visibility = page.HasMore ? Visibility.Visible : Visibility.Collapsed; if (!older && _messages.Count > 0) _list.ScrollIntoView(_messages[^1]); }
        finally { if (generation == _generation) _loading = false; }
    }
    private void AddVisible(ChatMessage message, bool scroll) { if (!Matches(message) || _messages.Any(view => view.Message.Id == message.Id)) return; _messages.Add(new MessageView(message, this)); if (scroll) _list.ScrollIntoView(_messages[^1]); }
    public async Task SendTextAsync(string text) { if (Client?.Session is null || string.IsNullOrWhiteSpace(text)) return; var message = await Client.SendTextAsync(_conversation, text.Trim(), Lifetime); _known[message.Id] = message; AddVisible(message, true); if (_composer.Text == text) _composer.Clear(); }
    private void ChooseFiles(bool media) { var dialog = new OpenFileDialog { Multiselect = true, Filter = media ? "Media|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.heic;*.mp4;*.mov;*.webm;*.mkv|All files|*.*" : "All files|*.*" }; if (dialog.ShowDialog(this) == true) _ = RunAsync(() => UploadFilesAsync(dialog.FileNames)); }
    private async Task UploadFilesAsync(string[] paths) { if (paths.Length > 20) throw new InvalidOperationException(L.T("一次最多选择 20 个文件。")); foreach (var path in paths) await UploadFileAsync(path); }
    public async Task UploadFileAsync(string path)
    {
        if (Client?.Session is null) throw new InvalidOperationException(L.T("请先连接设备。")); await _uploads.WaitAsync(Lifetime); _busy = true; _cancel.Visibility = Visibility.Visible; using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(Lifetime); _transferCancellation = cancellation; var client = Client; var destination = _conversation;
        try { _transfer.Text = Path.GetFileName(path) + " · " + L.T("等待上传…"); await client.UploadAsync(path, destination, new Progress<UploadProgress>(progress => _transfer.Text = Path.GetFileName(path) + $" · {progress.Percent}%"), cancellation.Token); _transfer.Text = L.T("已发送"); }
        catch (OperationCanceledException) when (!Lifetime.IsCancellationRequested) { _transfer.Text = L.T("已取消上传"); }
        finally { _busy = false; _cancel.Visibility = Visibility.Collapsed; _transferCancellation = null; _uploads.Release(); }
    }
    private async Task PasteImageAsync()
    {
        var bitmap = Clipboard.GetImage(); if (bitmap is null) return; var directory = Path.Combine(_options.ClientDir, "cache"); ManagedPaths.Create(directory); var file = Path.Combine(directory, "clipboard-" + Guid.NewGuid().ToString("N") + ".png");
        try { var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder(); encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap)); using (var output = File.Create(file)) encoder.Save(output); await UploadFileAsync(file); } finally { if (File.Exists(file)) File.Delete(file); }
    }
    public async Task HideMessageAsync(ChatMessage message, bool prompt = true)
    {
        if (prompt && !AppDialog.Show(L.T(message.Kind == "file" ? "从本设备的聊天记录中删除此文件？其他设备的记录和文件会保留。" : "从本设备的聊天记录中删除此消息？其他设备的记录会保留。"), "仅从本设备删除", this, confirm: true)) return;
        await Client!.HideAsync(message.Id, Lifetime); _known.Remove(message.Id); var view = _messages.FirstOrDefault(item => item.Message.Id == message.Id); if (view is not null) _messages.Remove(view);
    }
    public async Task SaveFileAsync(FileRef file) { var dialog = new SaveFileDialog { FileName = Path.GetFileName(file.Name), Filter = "All files|*.*", OverwritePrompt = true }; if (dialog.ShowDialog(this) != true) return; _transfer.Text = L.T("正在保存…"); await Client!.DownloadAsync(file.Id, dialog.FileName, Lifetime); _transfer.Text = L.T("保存完成"); }
    public void Preview(ChatMessage message)
    {
        if (message.File is null) return; if (message.File.Mime.StartsWith("image/", StringComparison.Ordinal)) { var photos = _messages.Select(view => view.Message).Where(item => item.File?.Mime.StartsWith("image/", StringComparison.Ordinal) == true).ToArray(); new MediaWindow(Client!, photos, Array.FindIndex(photos, item => item.Id == message.Id)) { Owner = this }.Show(); } else if (message.File.Mime.StartsWith("video/", StringComparison.Ordinal)) new VideoWindow(Client!, message.File, Path.Combine(_options.ClientDir, "cache")) { Owner = this }.Show();
    }
    private async Task RefreshQrAsync()
    {
        var client = Client; var entry = _entry; var image = _qr;
        if (client is null || entry.Length == 0) return;
        try { var bytes = await client.GetBytesAsync("api/qr?format=png&url=" + Uri.EscapeDataString(entry), 1024 * 1024, Lifetime); if (Client == client && _entry == entry && _qr == image) image.Source = Ui.Bitmap(bytes); }
        catch (OperationCanceledException) when (Lifetime.IsCancellationRequested) { }
        catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or NotSupportedException) { if (Client == client && _entry == entry && _qr == image) image.Source = null; }
    }
    private void ShowSettings()
    {
        if (Client?.Session is null) { ShowJoin(); return; }
        var dialog = Dialog("设备设置"); var panel = new StackPanel { Margin = new Thickness(24) }; panel.Children.Add(Ui.Text("设备设置", 22)); panel.Children.Add(Ui.Text("设备名称", 12, "Muted")); var name = Ui.Input(Client.Session.Device.Name, "DeviceName"); name.MaxLength = 30; name.Margin = new Thickness(0, 8, 0, 12); panel.Children.Add(name);
        var save = Ui.AsyncButton("保存修改", () => RunAsync(async () => { await Client.UpdateDeviceAsync(name.Text.Trim(), DeviceType.Computer, Lifetime); await CompleteJoinAsync(); dialog.Close(); }), "SaveSettings", true); save.Margin = new Thickness(0, 0, 0, 10); panel.Children.Add(save); var switchHost = Ui.Button("切换服务电脑", () => { dialog.Close(); ShowJoin(); }, "SwitchHost"); switchHost.Margin = new Thickness(0, 0, 0, 10); panel.Children.Add(switchHost); panel.Children.Add(Ui.AsyncButton("退出当前设备", () => RunAsync(async () => { await Client.LogoutAsync(Lifetime); _preferences.DeviceId = ""; _preferences.Save(_options.ClientDir); _known.Clear(); _messages.Clear(); Build(); dialog.Close(); ShowJoin(); }), "Logout")); dialog.Content = panel; dialog.ShowDialog();
    }
    private AppWindow Dialog(string title) => AppDialog.Create(title, this);
    public void ChangeAppearance(string? language, string? theme) { if (language is not null) _preferences.Language = language; if (theme is not null) _preferences.Theme = theme; L.Set(_preferences.Language); Theme.Apply(_preferences.Theme); _preferences.Save(_options.ClientDir); Build(); _ = RefreshQrAsync(); }
    internal Button CreateCopyButton(string label, Func<string> value, string id, string successKey)
    {
        Button? button = null; button = Ui.Button(label, () => Copy(value(), button, successKey, label.Length == 0), id);
        AutomationProperties.SetName(button, L.T(label.Length > 0 ? label : id == "CopyAddress" ? "复制地址" : "复制消息")); return button;
    }
    public void Copy(string value, Button? button = null, string successKey = "消息已复制", bool iconOnly = true)
    {
        if (_copyFeedback!.TryCopy(value, button, successKey, iconOnly)) CopyCompleted?.Invoke(value);
    }
    public async Task RunAsync(Func<Task> action) { try { await action(); _error.Visibility = Visibility.Collapsed; } catch (OperationCanceledException) when (Lifetime.IsCancellationRequested) { } catch (Exception ex) { ShowError(ex); } }
    private void ShowError(Exception ex) { _error.Text = L.T(ex.Message); _error.Visibility = Visibility.Visible; }
    public void RequestExit() { _exit = true; ExitRequested?.Invoke(); }
    public async Task ShutdownAsync() { _exit = true; _lifetime.Cancel(); _copyFeedback?.Dispose(); if (Client is not null) await Client.DisposeAsync(); if (_previousHandoffClient is not null) await _previousHandoffClient.DisposeAsync(); await _handoff.DisposeAsync(); Close(); }
}

public sealed class MessageCard : Border
{
    public static readonly DependencyProperty ModelProperty = DependencyProperty.Register(nameof(Model), typeof(MessageView), typeof(MessageCard), new PropertyMetadata(null, (dependency, _) => ((MessageCard)dependency).Build()));
    public MessageView? Model { get => (MessageView?)GetValue(ModelProperty); set => SetValue(ModelProperty, value); }
    private void Build()
    {
        if (Model is null) return; var message = Model.Message; var owner = Model.Owner; var mine = message.From == owner.Client?.Session?.Device.Id; Margin = new Thickness(0, 12, 0, 8); HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left; MaxWidth = message.Kind == "file" ? 344 : 650;
        var column = new StackPanel(); var device = owner.Client?.Devices.FirstOrDefault(item => item.Id == message.From); var metadata = Ui.Text((device?.Name ?? L.T("已离开的设备")) + "   " + DateTimeOffset.FromUnixTimeMilliseconds(message.CreatedAt).LocalDateTime.ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture), 11, "Muted"); metadata.Margin = new Thickness(0, 0, 0, 6); metadata.HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left; column.Children.Add(metadata);
        var card = new StackPanel(); var body = Ui.Border(card, mine ? "Selected" : "Surface", 10);
        if (message.File is { } file)
        {
            if (file.Mime.StartsWith("image/", StringComparison.Ordinal)) { var image = new Image { MaxHeight = 240, Width = 300, Stretch = Stretch.Uniform, Cursor = Cursors.Hand, Margin = new Thickness(0, 0, 0, 10) }; image.MouseLeftButtonUp += (_, _) => owner.Preview(message); card.Children.Add(image); _ = PreviewAsync(image, owner, file, message.Id); }
            else if (file.Mime.StartsWith("video/", StringComparison.Ordinal)) card.Children.Add(Ui.Button("▶  " + L.T("播放视频"), () => owner.Preview(message)));
            var label = Ui.Text(file.Name, 13); label.TextTrimming = TextTrimming.CharacterEllipsis; label.TextWrapping = TextWrapping.NoWrap; card.Children.Add(label); card.Children.Add(Ui.Text(Size(file.Size), 11, "Muted"));
        }
        else card.Children.Add(Ui.Text(message.Text, 15));
        var actions = Ui.Row(); actions.HorizontalAlignment = HorizontalAlignment.Right; actions.Margin = new Thickness(0, 7, 0, 0);
        if (message.File is not null) actions.Children.Add(Ui.AsyncButton("下载", () => owner.RunAsync(() => owner.SaveFileAsync(message.File)), "Download-" + message.Id)); else { var copy = owner.CreateCopyButton("", () => message.Text, "Copy-" + message.Id, "消息已复制"); copy.Content = Ui.Icon("copy"); copy.ToolTip = L.T("复制消息"); actions.Children.Add(copy); }
        var delete = Ui.AsyncButton("", () => owner.RunAsync(() => owner.HideMessageAsync(message)), "Delete-" + message.Id); delete.Content = Ui.Icon("delete"); delete.ToolTip = L.T("仅从本设备删除"); actions.Children.Add(delete); foreach (var button in actions.Children.OfType<Button>()) { button.Height = 28; button.Padding = new Thickness(6, 3, 6, 3); button.BorderThickness = new Thickness(0); button.SetResourceReference(Control.BackgroundProperty, mine ? "Selected" : "Surface"); if (button.Content is TextBlock icon) { icon.FontSize = 14; icon.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); } }
        card.Children.Add(actions); column.Children.Add(body);
        var menu = new ContextMenu(); if (message.File is not null) { var save = new MenuItem { Header = L.T("另存为…") }; save.Click += async (_, _) => await owner.RunAsync(() => owner.SaveFileAsync(message.File)); menu.Items.Add(save); } else { var copy = new MenuItem { Header = L.T("复制消息") }; copy.Click += (_, _) => owner.Copy(message.Text); menu.Items.Add(copy); }
        ContextMenu = menu;
        if (mine) { var sent = Ui.Text("已发送", 11, "Muted"); sent.HorizontalAlignment = HorizontalAlignment.Right; sent.Margin = new Thickness(0, 5, 0, 0); column.Children.Add(sent); }
        Child = column;
    }
    private async Task PreviewAsync(Image image, MainWindow owner, FileRef file, string id) { try { var bytes = await owner.Client!.GetBytesAsync("api/files/" + Uri.EscapeDataString(file.Id) + "/preview?format=png", 8 * 1024 * 1024, owner.Lifetime); if (Model?.Message.Id == id) image.Source = Ui.Bitmap(bytes); } catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or OperationCanceledException or NotSupportedException) { image.Visibility = Visibility.Collapsed; } }
    public static string Size(long size) => size >= 1024 * 1024 * 1024 ? $"{size / (1024d * 1024 * 1024):0.0} GB" : size >= 1024 * 1024 ? $"{size / (1024d * 1024):0.0} MB" : $"{size / 1024d:0.0} KB";
}
