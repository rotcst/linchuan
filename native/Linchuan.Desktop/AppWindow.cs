using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Shell;
using System.Windows.Interop;
using System.Windows.Threading;
using System.Runtime.InteropServices;

namespace Linchuan.Desktop;

/// <summary>Shared native window frame, including the caption, follows the app's theme resources.</summary>
public class AppWindow : Window
{
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MinMaxInfo { public NativePoint Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public int Size; public NativeRect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr window, IntPtr region, [MarshalAs(UnmanagedType.Bool)] bool redraw);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr objectHandle);
    [DllImport("user32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowRect(IntPtr window, out NativeRect bounds);
    private const int DwmWindowCornerPreference = 33;
    private const int DwmRound = 2;
    private const int DwmDoNotRound = 1;
    private bool _cornerUpdateQueued;
    private HwndSource? _source;
    public string CaptionResource { get; }
    public AppWindow(string captionResource = "Rail", bool integratedCaption = false)
    {
        CaptionResource = captionResource;
        WindowStyle = WindowStyle.None;
        SetResourceReference(BackgroundProperty, captionResource);
        SetResourceReference(ForegroundProperty, "Text");
        SetResourceReference(FontFamilyProperty, "Font");
        WindowChrome.SetWindowChrome(this, new WindowChrome
        {
            CaptionHeight = integratedCaption ? Theme.Number("layout-header", 56) : Theme.Number("space-8", 32),
            ResizeBorderThickness = new Thickness(6),
            GlassFrameThickness = new Thickness(0),
            CornerRadius = new CornerRadius(0),
            UseAeroCaptionButtons = false,
        });
        var border = new FrameworkElementFactory(typeof(Border), "WindowFrame");
        border.SetResourceReference(Border.BackgroundProperty, captionResource);
        border.SetResourceReference(Border.BorderBrushProperty, "Border");
        border.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(Theme.Number("radius-panel", 10)));
        var root = new FrameworkElementFactory(typeof(DockPanel));
        if (!integratedCaption)
        {
            var caption = new FrameworkElementFactory(typeof(AppCaption), "WindowCaption");
            caption.SetValue(DockPanel.DockProperty, Dock.Top);
            root.AppendChild(caption);
        }
        var content = new FrameworkElementFactory(typeof(ContentPresenter), "WindowContent");
        content.SetValue(ContentPresenter.ContentSourceProperty, "Content");
        root.AppendChild(content); border.AppendChild(root);
        var template = new ControlTemplate(typeof(Window)) { VisualTree = border };
        var maximized = new Trigger { Property = WindowStateProperty, Value = WindowState.Maximized };
        maximized.Setters.Add(new Setter(Border.CornerRadiusProperty, new CornerRadius(0), "WindowFrame"));
        template.Triggers.Add(maximized); Template = template;
        SourceInitialized += (_, _) => { _source = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle); _source?.AddHook(WindowMessages); QueueWindowCorners(); };
        Loaded += (_, _) => QueueWindowCorners();
        StateChanged += (_, _) => QueueWindowCorners();
        SizeChanged += (_, _) => QueueWindowCorners();
        Theme.Changed += QueueWindowCorners;
        Closed += (_, _) => { Theme.Changed -= QueueWindowCorners; _source?.RemoveHook(WindowMessages); _source = null; };
    }
    private IntPtr WindowMessages(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == 0x02E0) { QueueWindowCorners(); return IntPtr.Zero; }
        if (message != 0x0024) return IntPtr.Zero;
        var monitor = MonitorFromWindow(window, 2); var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (lParam == IntPtr.Zero || monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return IntPtr.Zero;
        var limits = Marshal.PtrToStructure<MinMaxInfo>(lParam);
        limits.MaxPosition = new NativePoint { X = info.Work.Left - info.Monitor.Left, Y = info.Work.Top - info.Monitor.Top };
        limits.MaxSize = new NativePoint { X = info.Work.Right - info.Work.Left, Y = info.Work.Bottom - info.Work.Top };
        limits.MaxTrackSize = limits.MaxSize;
        var dpi = GetDpiForWindow(window); if (dpi == 0) dpi = 96;
        var scale = dpi / 96d;
        var minWidth = double.IsFinite(MinWidth) && MinWidth > 0 ? (int)Math.Ceiling(MinWidth * scale) : 0;
        var minHeight = double.IsFinite(MinHeight) && MinHeight > 0 ? (int)Math.Ceiling(MinHeight * scale) : 0;
        limits.MinTrackSize = new NativePoint { X = Math.Max(limits.MinTrackSize.X, minWidth), Y = Math.Max(limits.MinTrackSize.Y, minHeight) };
        Marshal.StructureToPtr(limits, lParam, false); handled = true; return IntPtr.Zero;
    }
    private void QueueWindowCorners()
    {
        if (_cornerUpdateQueued || _source is null) return;
        _cornerUpdateQueued = true;
        Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, new Action(() => { _cornerUpdateQueued = false; ApplyWindowCorners(); }));
    }
    private void ApplyWindowCorners()
    {
        if (_source is null) return;
        var handle = _source.Handle;
        var rounded = WindowState != WindowState.Maximized;
        var preference = rounded ? DwmRound : DwmDoNotRound;
        var dwmSupported = Environment.OSVersion.Version.Build >= 22000 && DwmSetWindowAttribute(handle, DwmWindowCornerPreference, ref preference, sizeof(int)) == 0;
        if (dwmSupported)
        {
            // WindowChrome may have installed a rectangular region while creating
            // the HWND. DWM rounding only affects an unregioned window.
            SetWindowRgn(handle, IntPtr.Zero, true);
            return;
        }
        if (!rounded || !GetWindowRect(handle, out var bounds)) { SetWindowRgn(handle, IntPtr.Zero, true); return; }
        var dpi = GetDpiForWindow(handle); if (dpi == 0) dpi = 96;
        var radius = Math.Max(1, (int)Math.Round(Theme.Number("radius-panel", 10) * dpi / 96d));
        var width = bounds.Right - bounds.Left; var height = bounds.Bottom - bounds.Top;
        if (width <= 0 || height <= 0) return;
        var region = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
        if (region == IntPtr.Zero || SetWindowRgn(handle, region, true) == 0) { if (region != IntPtr.Zero) DeleteObject(region); }
    }
    protected override void OnPropertyChanged(DependencyPropertyChangedEventArgs e)
    {
        base.OnPropertyChanged(e);
        if (e.Property == ResizeModeProperty && WindowChrome.GetWindowChrome(this) is { } chrome) chrome.ResizeBorderThickness = (ResizeMode)e.NewValue == ResizeMode.NoResize ? new Thickness(0) : new Thickness(6);
    }
}

public sealed class AppCaption : DockPanel
{
    private readonly TextBlock _title;
    private readonly Button _minimize, _maximize, _close;
    private AppWindow? _window;
    public bool ShowTitle { get; set; } = true;
    public AppCaption()
    {
        Height = Theme.Number("space-8", 32);
        AutomationProperties.SetAutomationId(this, "WindowCaption");
        var controls = new StackPanel { Orientation = Orientation.Horizontal };
        DockPanel.SetDock(controls, Dock.Right); Children.Add(controls);
        _minimize = CaptionButton("\uE921", "最小化", () => { if (_window is not null) SystemCommands.MinimizeWindow(_window); }, "WindowMinimize");
        _maximize = CaptionButton("\uE922", "最大化", () => { if (_window is not null) { if (_window.WindowState == WindowState.Maximized) SystemCommands.RestoreWindow(_window); else SystemCommands.MaximizeWindow(_window); } }, "WindowMaximize");
        _close = CaptionButton("\uE8BB", "关闭", () => { if (_window is not null) SystemCommands.CloseWindow(_window); }, "WindowClose");
        controls.Children.Add(_minimize); controls.Children.Add(_maximize); controls.Children.Add(_close);
        _title = Ui.Text("", 12, "Muted"); _title.Margin = new Thickness(12, 0, 12, 0); _title.TextWrapping = TextWrapping.NoWrap; _title.TextTrimming = TextTrimming.CharacterEllipsis; Children.Add(_title);
        Loaded += (_, _) =>
        {
            _window = Window.GetWindow(this) as AppWindow;
            if (_window is null) return;
            SetResourceReference(BackgroundProperty, _window.CaptionResource);
            _title.Visibility = ShowTitle ? Visibility.Visible : Visibility.Collapsed;
            _title.SetBinding(TextBlock.TextProperty, new Binding(nameof(Window.Title)) { Source = _window });
            _window.StateChanged += Refresh; Theme.Changed += RefreshTheme; Refresh(null, EventArgs.Empty);
        };
        Unloaded += (_, _) => { if (_window is not null) _window.StateChanged -= Refresh; Theme.Changed -= RefreshTheme; };
        SizeChanged += (_, _) => { foreach (var button in new[] { _minimize, _maximize, _close }) button.Height = ActualHeight; };
    }
    private static Button CaptionButton(string glyph, string label, Action action, string id)
    {
        var button = Ui.Button("", action, id); button.Height = Theme.Number("space-8", 32); button.Width = 44; button.Padding = new Thickness(0); button.BorderThickness = new Thickness(0); button.SetResourceReference(Control.BackgroundProperty, "Rail");
        button.SetResourceReference(Control.ForegroundProperty, "Text");
        var icon = Ui.Text(glyph, 10); icon.FontFamily = new FontFamily("Segoe MDL2 Assets"); icon.SetBinding(TextBlock.ForegroundProperty, new Binding(nameof(Control.Foreground)) { Source = button }); button.Content = icon; button.ToolTip = L.T(label); AutomationProperties.SetName(button, L.T(label)); WindowChrome.SetIsHitTestVisibleInChrome(button, true);
        var frame = new FrameworkElementFactory(typeof(Border)); frame.SetBinding(Border.BackgroundProperty, new Binding(nameof(Control.Background)) { RelativeSource = RelativeSource.TemplatedParent });
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center); presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center); frame.AppendChild(presenter);
        var template = new ControlTemplate(typeof(Button)) { VisualTree = frame }; var hover = new Trigger { Property = IsMouseOverProperty, Value = true }; hover.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(id == "WindowClose" ? "Danger" : "Hover"))); if (id == "WindowClose") hover.Setters.Add(new Setter(Control.ForegroundProperty, Brushes.White)); template.Triggers.Add(hover); button.Template = template;
        return button;
    }
    private void Refresh(object? sender, EventArgs e)
    {
        if (_window is null) return;
        _minimize.Visibility = _window.ResizeMode == ResizeMode.NoResize ? Visibility.Collapsed : Visibility.Visible;
        _maximize.Visibility = _window.ResizeMode is ResizeMode.CanResize or ResizeMode.CanResizeWithGrip ? Visibility.Visible : Visibility.Collapsed;
        var maximizeIcon = new TextBlock { Text = _window.WindowState == WindowState.Maximized ? "\uE923" : "\uE922", FontFamily = new FontFamily("Segoe MDL2 Assets"), FontSize = 10 }; maximizeIcon.SetBinding(TextBlock.ForegroundProperty, new Binding(nameof(Control.Foreground)) { Source = _maximize }); _maximize.Content = maximizeIcon;
        var maximizeLabel = L.T(_window.WindowState == WindowState.Maximized ? "还原窗口" : "最大化"); _maximize.ToolTip = maximizeLabel; AutomationProperties.SetName(_maximize, maximizeLabel);
        _minimize.ToolTip = L.T("最小化"); AutomationProperties.SetName(_minimize, L.T("最小化")); _close.ToolTip = L.T("关闭"); AutomationProperties.SetName(_close, L.T("关闭"));
        foreach (var button in new[] { _minimize, _maximize, _close }) button.SetResourceReference(Control.BackgroundProperty, _window.CaptionResource);
    }
    private void RefreshTheme() => Refresh(null, EventArgs.Empty);
}

public static class AppDialog
{
    public static AppWindow Create(string title, Window? owner = null) => new("Surface") { Owner = owner, Title = L.T(title), Width = 470, SizeToContent = SizeToContent.Height, MaxHeight = 650, ResizeMode = ResizeMode.NoResize, ShowInTaskbar = false, WindowStartupLocation = owner is null ? WindowStartupLocation.CenterScreen : WindowStartupLocation.CenterOwner };
    public static bool Show(string message, string title, Window? owner = null, bool confirm = false)
    {
        var application = Application.Current ?? new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        if (!application.Resources.Contains("Surface")) { L.Set(L.DefaultLanguage); Theme.Apply("system"); }
        var dialog = Create(title, owner); var body = new StackPanel { Margin = new Thickness(24) }; body.Children.Add(Ui.Text(message, 14)); var actions = Ui.Row(); actions.HorizontalAlignment = HorizontalAlignment.Right; actions.Margin = new Thickness(0, 24, 0, 0);
        if (confirm) { var cancel = Ui.Button("取消", () => dialog.DialogResult = false, "ConfirmCancel"); cancel.IsCancel = true; actions.Children.Add(cancel); }
        var accept = Ui.Button("确定", () => dialog.DialogResult = true, "ConfirmAccept", primary: true); accept.IsDefault = true; actions.Children.Add(accept); body.Children.Add(actions); dialog.Content = body; return dialog.ShowDialog() == true;
    }
}
