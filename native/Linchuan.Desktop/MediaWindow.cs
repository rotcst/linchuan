using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Linchuan.Desktop.Core;
using Microsoft.Win32;

namespace Linchuan.Desktop;

public sealed class MediaWindow : AppWindow
{
    private readonly LanClient _client;
    private readonly IReadOnlyList<ChatMessage> _photos;
    private readonly CancellationTokenSource _life = new();
    private readonly Image _image = new() { Stretch = Stretch.Uniform };
    private readonly ScaleTransform _scale = new(1, 1);
    private readonly TranslateTransform _pan = new();
    private readonly TextBlock _label = Ui.Text("", 13);
    private Point? _pointer;
    private int _index, _generation;
    public int Index => _index;
    public double Zoom => _scale.ScaleX;
    public Task ImageReady { get; private set; } = Task.CompletedTask;
    public MediaWindow(LanClient client, IReadOnlyList<ChatMessage> photos, int index)
    {
        _client = client; _photos = photos; _index = Math.Max(0, index); Title = L.T("图片查看器"); Width = 1020; Height = 760; MinWidth = 540; MinHeight = 420; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        SetResourceReference(Control.BackgroundProperty, "Page"); SetResourceReference(Control.ForegroundProperty, "Text");
        var root = new DockPanel(); var tools = Ui.Row(Ui.Button("‹", () => Navigate(-1), "Previous"), Ui.Button("›", () => Navigate(1), "Next"), Ui.Button("−", () => SetZoom(Zoom / 1.2), "ZoomOut"), Ui.Button("＋", () => SetZoom(Zoom * 1.2), "ZoomIn"), Ui.Button("100%", () => Reset(), "ResetZoom"), Ui.AsyncButton("下载原图", SaveAsync, "SavePhoto")); tools.Margin = new Thickness(16); DockPanel.SetDock(tools, Dock.Bottom); root.Children.Add(tools); _label.Margin = new Thickness(16); DockPanel.SetDock(_label, Dock.Top); root.Children.Add(_label);
        var viewport = new Grid { ClipToBounds = true, Background = Brushes.Transparent }; var transforms = new TransformGroup(); transforms.Children.Add(_scale); transforms.Children.Add(_pan); _image.RenderTransform = transforms; _image.RenderTransformOrigin = new Point(.5, .5); viewport.Children.Add(_image); root.Children.Add(viewport);
        viewport.PreviewMouseWheel += (_, e) => { SetZoom(Zoom * Math.Pow(1.15, e.Delta / 120d)); e.Handled = true; };
        viewport.MouseLeftButtonDown += (_, e) => { if (Zoom <= 1) return; _pointer = e.GetPosition(viewport); viewport.CaptureMouse(); };
        viewport.MouseMove += (_, e) => { if (_pointer is not { } previous || e.LeftButton != MouseButtonState.Pressed) return; var point = e.GetPosition(viewport); _pan.X += point.X - previous.X; _pan.Y += point.Y - previous.Y; _pointer = point; };
        viewport.MouseLeftButtonUp += (_, _) => { _pointer = null; viewport.ReleaseMouseCapture(); }; viewport.MouseDown += (_, e) => { if (e.ClickCount == 2) Reset(); };
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Left) { Navigate(-1); e.Handled = true; } else if (e.Key == Key.Right) { Navigate(1); e.Handled = true; } else if (e.Key == Key.Escape) Close(); };
        var menu = new ContextMenu(); var save = new MenuItem { Header = L.T("另存为…") }; save.Click += async (_, _) => await SaveAsync(); menu.Items.Add(save); _image.ContextMenu = menu;
        Content = root; Closed += (_, _) => _life.Cancel(); ImageReady = LoadAsync();
    }
    public void SetZoom(double value) { _scale.ScaleX = _scale.ScaleY = Math.Clamp(value, .25, 12); if (value <= 1) _pan.X = _pan.Y = 0; }
    public void Reset() { SetZoom(1); _pan.X = _pan.Y = 0; }
    public void Navigate(int direction) { if (_photos.Count == 0) return; var next = Math.Clamp(_index + direction, 0, _photos.Count - 1); if (next == _index) return; _index = next; Reset(); ImageReady = LoadAsync(); }
    private async Task LoadAsync()
    {
        if (_photos.Count == 0) return; var generation = ++_generation; var file = _photos[_index].File!; _label.Text = $"{_index + 1} / {_photos.Count}   {file.Name}"; _image.Source = null;
        try { var bytes = await _client.GetBytesAsync("api/files/" + Uri.EscapeDataString(file.Id) + "/preview?large=1&format=png", 20 * 1024 * 1024, _life.Token); if (generation == _generation && !_life.IsCancellationRequested) _image.Source = Ui.Bitmap(bytes); }
        catch (OperationCanceledException) { }
        catch (Exception ex) { _label.Text = L.T("此文件无法直接预览，可下载原文件查看。") + " " + L.T(ex.Message); }
    }
    private async Task SaveAsync()
    {
        if (_photos.Count == 0) return; var file = _photos[_index].File!; var picker = new SaveFileDialog { FileName = Path.GetFileName(file.Name), OverwritePrompt = true };
        if (picker.ShowDialog(this) != true) return; try { await _client.DownloadAsync(file.Id, picker.FileName, _life.Token); } catch (Exception ex) when (ex is not OperationCanceledException) { _label.Text = L.T(ex.Message); }
    }
}

public sealed class VideoWindow : AppWindow
{
    private readonly LanClient _client;
    private readonly FileRef _file;
    private readonly string _cache;
    private readonly CancellationTokenSource _life = new();
    private readonly MediaElement _video = new() { LoadedBehavior = MediaState.Manual, UnloadedBehavior = MediaState.Close, Stretch = Stretch.Uniform };
    private readonly TextBlock _label = Ui.Text("准备中…", 13);
    private bool _closed;
    public VideoWindow(LanClient client, FileRef file, string directory)
    {
        _client = client; _file = file; ManagedPaths.Create(directory);
        var extension = Path.GetExtension(file.Name).ToLowerInvariant(); if (!new[] { ".mp4", ".mov", ".webm", ".mkv" }.Contains(extension)) extension = ".mp4";
        _cache = Path.Combine(directory, "video-" + Guid.NewGuid().ToString("N") + extension); Title = file.Name; Width = 960; Height = 680; WindowStartupLocation = WindowStartupLocation.CenterOwner; SetResourceReference(Control.BackgroundProperty, "Page");
        var root = new DockPanel(); var controls = Ui.Row(Ui.Button("▶", () => _video.Play()), Ui.Button("Ⅱ", () => _video.Pause()), Ui.Button("↺", () => { _video.Position = TimeSpan.Zero; _video.Play(); }), Ui.AsyncButton("下载原文件", SaveAsync)); controls.Margin = new Thickness(16); DockPanel.SetDock(controls, Dock.Bottom); root.Children.Add(controls); _label.Margin = new Thickness(16); DockPanel.SetDock(_label, Dock.Top); root.Children.Add(_label);
        var volume = new Slider { Minimum = 0, Maximum = 1, Value = .7, Width = 100, ToolTip = L.T("音量") }; volume.ValueChanged += (_, _) => _video.Volume = volume.Value; controls.Children.Add(volume);
        var seek = new Slider { Minimum = 0, Maximum = 1, Width = 240, ToolTip = L.T("播放进度") }; seek.PreviewMouseLeftButtonUp += (_, _) => { if (_video.NaturalDuration.HasTimeSpan) _video.Position = TimeSpan.FromSeconds(_video.NaturalDuration.TimeSpan.TotalSeconds * seek.Value); }; controls.Children.Add(seek);
        _video.MediaOpened += (_, _) => _label.Text = file.Name; _video.MediaFailed += (_, _) => _label.Text = L.T("系统不支持此视频编码，请下载原文件。") + " " + file.Name; root.Children.Add(_video); Content = root;
        Closed += (_, _) => { _closed = true; _life.Cancel(); _video.Close(); Cleanup(); }; Loaded += async (_, _) => await PrepareAsync();
    }
    private async Task PrepareAsync()
    {
        try { var drive = new DriveInfo(Path.GetPathRoot(_cache)!); if (drive.AvailableFreeSpace < _file.Size + 256L * 1024 * 1024) throw new IOException(L.T("服务电脑的磁盘空间不足，请先释放磁盘空间。")); await _client.DownloadAsync(_file.Id, _cache, _life.Token); if (!_closed) { _video.Source = new Uri(_cache); _video.Play(); } }
        catch (OperationCanceledException) { }
        catch (Exception ex) { if (!_closed) _label.Text = L.T(ex.Message); }
        finally { if (_closed) Cleanup(); }
    }
    private async Task SaveAsync() { var dialog = new SaveFileDialog { FileName = Path.GetFileName(_file.Name), OverwritePrompt = true }; if (dialog.ShowDialog(this) != true) return; try { await _client.DownloadAsync(_file.Id, dialog.FileName, _life.Token); } catch (Exception ex) when (ex is not OperationCanceledException) { _label.Text = L.T(ex.Message); } }
    private void Cleanup() { try { if (File.Exists(_cache)) File.Delete(_cache); } catch (IOException) { } }
}
