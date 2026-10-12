using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace Linchuan.Desktop;

/// <summary>Shared clipboard feedback without rebuilding controls or moving keyboard focus.</summary>
internal sealed class CopyFeedback : IDisposable
{
    private readonly Action<string> _write;
    private readonly DispatcherTimer _timer;
    private readonly TextBlock _text;
    private Button? _button;
    private object? _content, _tooltip;
    private Brush? _background;
    private string _name = "";
    private double _width;
    private DateTime _expires;

    public CopyFeedback(Action<string> write)
    {
        _write = write;
        _text = Ui.Text("", 13, "ToastText");
        AutomationProperties.SetAutomationId(_text, "CopyFeedbackText");
        AutomationProperties.SetLiveSetting(_text, AutomationLiveSetting.Polite);
        View = Ui.Border(_text, "ToastSurface", 12);
        View.BorderThickness = new Thickness(0); View.MaxWidth = 480;
        View.Visibility = Visibility.Collapsed; View.IsHitTestVisible = false;
        View.HorizontalAlignment = HorizontalAlignment.Center; View.VerticalAlignment = VerticalAlignment.Bottom;
        View.Margin = new Thickness(18, 0, 18, 12);
        AutomationProperties.SetAutomationId(View, "CopyFeedback");
        _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(2) };
        _timer.Tick += OnTick;
    }
    public Border View { get; }
    public bool TryCopy(string value, Button? button, string successKey, bool iconOnly)
    {
        _timer.Stop(); RestoreButton();
        if (value.Length == 0) { Show("没有可复制的内容。"); return false; }
        try { _write(value); }
        catch (Exception ex) when (ex is ExternalException or InvalidOperationException or System.Threading.ThreadStateException)
        {
            Show("复制失败，剪贴板可能被其他程序占用，请重试。"); return false;
        }
        if (button is not null)
        {
            _button = button; _content = button.Content; _tooltip = button.ToolTip;
            _background = button.Background; _name = AutomationProperties.GetName(button); _width = button.Width;
            if (button.ActualWidth > 0) button.Width = button.ActualWidth;
            button.SetCurrentValue(Control.BackgroundProperty, Ui.Brush("Accent"));
            if (iconOnly)
            {
                var check = new System.Windows.Shapes.Path { Data = Geometry.Parse("M 2,8 L 6,12 L 14,3"), Width = 14, Height = 14, Stretch = Stretch.Uniform, StrokeThickness = 1.8, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round };
                check.SetResourceReference(System.Windows.Shapes.Shape.StrokeProperty, "OnAccent"); button.Content = check;
            }
            else button.Content = Ui.Text("已复制", 13, "OnAccent");
            button.ToolTip = L.T("已复制"); AutomationProperties.SetName(button, L.T("已复制"));
        }
        Show(successKey); return true;
    }
    private void Show(string key)
    {
        _text.Text = L.T(key); AutomationProperties.SetName(_text, _text.Text);
        View.Visibility = Visibility.Visible;
        UIElementAutomationPeer.CreatePeerForElement(_text)?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
        _expires = DateTime.UtcNow.AddSeconds(2); _timer.Start();
    }
    private void OnTick(object? sender, EventArgs e)
    {
        if (DateTime.UtcNow < _expires) return;
        _timer.Stop(); RestoreButton(); View.Visibility = Visibility.Collapsed;
    }
    private void RestoreButton()
    {
        if (_button is null) return;
        _button.Content = _content; _button.ToolTip = _tooltip; _button.Width = _width;
        _button.SetCurrentValue(Control.BackgroundProperty, _background);
        AutomationProperties.SetName(_button, _name);
        _button = null; _content = _tooltip = null; _background = null;
    }
    public void Dispose() { _timer.Stop(); _timer.Tick -= OnTick; RestoreButton(); View.Visibility = Visibility.Collapsed; }
}
