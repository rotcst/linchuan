using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;

namespace Linchuan.Desktop;

/// <summary>The tray uses the same WPF theme resources as the main window, including while it is hidden.</summary>
internal sealed class TrayMenu : ContextMenu, IDisposable
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr window);
    private readonly MenuItem _open, _exit, _update;
    private readonly TextBlock _version;
    public TrayMenu(Action open, Action exit, Func<Task>? checkUpdates = null)
    {
        Width = Theme.Number("tray-menu-width", 156);
        StaysOpen = false; HasDropShadow = false; FocusVisualStyle = null;
        SetResourceReference(BackgroundProperty, "TraySurface");
        SetResourceReference(BorderBrushProperty, "Border");
        SetResourceReference(ForegroundProperty, "Text");
        SetResourceReference(FontFamilyProperty, "Font");
        AutomationProperties.SetAutomationId(this, "TrayMenu");
        var frame = new FrameworkElementFactory(typeof(Border));
        frame.SetValue(Border.CornerRadiusProperty, new CornerRadius(Theme.Number("tray-menu-radius", 8)));
        frame.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        frame.SetBinding(Border.BackgroundProperty, new Binding(nameof(Background)) { RelativeSource = RelativeSource.TemplatedParent });
        frame.SetBinding(Border.BorderBrushProperty, new Binding(nameof(BorderBrush)) { RelativeSource = RelativeSource.TemplatedParent });
        var items = new FrameworkElementFactory(typeof(ItemsPresenter));
        items.SetValue(MarginProperty, new Thickness(Theme.Number("tray-menu-padding", 5)));
        frame.AppendChild(items); Template = new ControlTemplate(typeof(ContextMenu)) { VisualTree = frame };
        var versionItem = Item("", "TrayVersion", null); versionItem.Height = 24; versionItem.IsEnabled = false;
        _version = new TextBlock { Text = L.T("版本") + " " + AppVersion.Display, FontSize = 10, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 10, 0), IsEnabled = false };
        _version.SetResourceReference(TextBlock.ForegroundProperty, "Muted"); versionItem.Header = _version;
        _update = Item("检查更新", "TrayCheckUpdates", checkUpdates is null ? null : () => _ = checkUpdates());
        _open = Item("打开邻传", "TrayOpen", open); _exit = Item("退出邻传", "TrayExit", exit);
        Items.Add(versionItem); Items.Add(_update); Items.Add(_open); Items.Add(_exit);
        Opened += (_, _) =>
        {
            RefreshTheme();
            _version.Text = L.T("版本") + " " + AppVersion.Display; _open.Header = L.T("打开邻传"); _update.Header = L.T("检查更新"); _exit.Header = L.T("退出邻传");
            if (PresentationSource.FromVisual(this) is HwndSource source) { SetForegroundWindow(source.Handle); SetFocus(source.Handle); }
        };
        Theme.Changed += RefreshTheme; RefreshTheme();
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) { IsOpen = false; e.Handled = true; } };
    }
    private void RefreshTheme()
    {
        // A tray popup has its own HWND and no visible placement target. Keep its resource scope current.
        foreach (var key in new[] { "TraySurface", "TrayActive", "TrayActiveText", "Border", "Text", "Muted", "Font" }) Resources[key] = Application.Current.Resources[key];
    }
    public void Dispose() { IsOpen = false; Theme.Changed -= RefreshTheme; }
    public void ShowForTray()
    {
        if (IsOpen) { IsOpen = false; return; }
        PlacementTarget = null; Placement = PlacementMode.MousePoint; IsOpen = true;
    }
    private MenuItem Item(string label, string id, Action? action)
    {
        var item = new MenuItem { Header = L.T(label), Height = Theme.Number("tray-menu-option-height", 32), FontSize = Theme.Number("tray-menu-font-size", 13), FocusVisualStyle = null, Padding = new Thickness(0), Cursor = Cursors.Hand };
        var style = new Style(typeof(MenuItem)); style.Setters.Add(new Setter(BackgroundProperty, Brushes.Transparent)); style.Setters.Add(new Setter(ForegroundProperty, new DynamicResourceExtension("Text"))); item.Style = style;
        AutomationProperties.SetAutomationId(item, id);
        var frame = new FrameworkElementFactory(typeof(Border));
        frame.SetValue(Border.CornerRadiusProperty, new CornerRadius(Theme.Number("tray-menu-option-radius", 6)));
        frame.SetBinding(Border.BackgroundProperty, new Binding(nameof(Background)) { RelativeSource = RelativeSource.TemplatedParent });
        var labelPresenter = new FrameworkElementFactory(typeof(ContentPresenter));
        labelPresenter.SetValue(ContentPresenter.ContentSourceProperty, "Header");
        labelPresenter.SetValue(HorizontalAlignmentProperty, HorizontalAlignment.Center);
        labelPresenter.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center);
        frame.AppendChild(labelPresenter);
        var template = new ControlTemplate(typeof(MenuItem)) { VisualTree = frame };
        foreach (var property in new[] { MenuItem.IsHighlightedProperty, IsKeyboardFocusedProperty })
        {
            var active = new Trigger { Property = property, Value = true };
            active.Setters.Add(new Setter(BackgroundProperty, new DynamicResourceExtension("TrayActive")));
            active.Setters.Add(new Setter(ForegroundProperty, new DynamicResourceExtension("TrayActiveText")));
            template.Triggers.Add(active);
        }
        item.Template = template;
        if (action is not null) item.Click += (_, _) => { IsOpen = false; action(); };
        return item;
    }
}
