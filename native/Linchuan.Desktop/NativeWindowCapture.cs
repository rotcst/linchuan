using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Drawing = System.Drawing;

namespace Linchuan.Desktop;

/// <summary>QA captures only this process's window, including its native frame.</summary>
internal static class NativeWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PrintWindow(IntPtr window, IntPtr context, uint flags);
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")]
    private static extern bool CloseClipboard();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetCurrentPackageFullName(ref int length, StringBuilder? name);
    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("user32.dll")]
    private static extern int GetWindowRgn(IntPtr window, IntPtr region);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PtInRegion(IntPtr region, int x, int y);
    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr objectHandle);
    private const int DwmWindowCornerPreference = 33;
    private const int DwmRound = 2;
    private const int DwmDoNotRound = 1;
    public static bool IsPackagedProcess
    {
        get { var length = 512; return GetCurrentPackageFullName(ref length, new StringBuilder(length)) != 15700; }
    }
    public static string ReadClipboardUnicode(Window window)
    {
        if (!OpenClipboard(new WindowInteropHelper(window).Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var memory = GetClipboardData(13);
            if (memory == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var size = GlobalSize(memory).ToUInt64();
            if (size < 2 || size > 1024 * 1024 || size % 2 != 0) throw new InvalidDataException("Unexpected QA clipboard buffer size.");
            var pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var value = Marshal.PtrToStringUni(pointer, checked((int)(size / 2))) ?? "";
                var terminator = value.IndexOf('\0');
                if (terminator < 0) throw new InvalidDataException("QA clipboard text is not terminated.");
                return value[..terminator];
            }
            finally { GlobalUnlock(memory); }
        }
        finally { CloseClipboard(); }
    }
    public static int HitTest(Window window, Point position)
    {
        var screen = window.PointToScreen(position); var packed = unchecked(((int)screen.Y << 16) | ((int)screen.X & 0xffff));
        return (int)SendMessage(new WindowInteropHelper(window).Handle, 0x0084, IntPtr.Zero, new IntPtr(packed));
    }
    public static bool FitsWorkArea(Window window, FrameworkElement content)
    {
        var work = System.Windows.Forms.Screen.FromHandle(new WindowInteropHelper(window).Handle).WorkingArea;
        var bottom = content.PointToScreen(new Point(content.ActualWidth, content.ActualHeight));
        return bottom.X <= work.Right + 1 && bottom.Y <= work.Bottom + 1;
    }
    /// <summary>Checks the effective rounded-corner policy without changing window state.</summary>
    public static bool HasExpectedCorners(Window window)
    {
        var handle = new WindowInteropHelper(window).Handle;
        var expectedDwm = window.WindowState == WindowState.Maximized ? DwmDoNotRound : DwmRound;
        if (Environment.OSVersion.Version.Build >= 22000 && DwmGetWindowAttribute(handle, DwmWindowCornerPreference, out var preference, sizeof(int)) == 0)
        {
            if (preference != expectedDwm || !GetWindowRect(handle, out var dwmBounds)) return false;
            using var dwmRegion = new RegionHandle(handle, dwmBounds.Right - dwmBounds.Left, dwmBounds.Bottom - dwmBounds.Top);
            return !dwmRegion.IsPresent;
        }
        if (window.WindowState == WindowState.Maximized)
        {
            using var region = new RegionHandle(handle);
            return region.IsEmpty;
        }
        if (!GetWindowRect(handle, out var bounds)) return false;
        using var rounded = new RegionHandle(handle, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
        return rounded.IsPresent && !rounded.Contains(0, 0) && !rounded.Contains(Math.Max(0, rounded.Width - 1), 0) && !rounded.Contains(0, Math.Max(0, rounded.Height - 1)) && !rounded.Contains(Math.Max(0, rounded.Width - 1), Math.Max(0, rounded.Height - 1)) && rounded.Contains(rounded.Width / 2, rounded.Height / 2);
    }
    public static void Save(Visual visual, string file, string? captionResource = null)
    {
        var source = PresentationSource.FromVisual(visual) as HwndSource ?? throw new InvalidOperationException("QA visual has no native window.");
        if (!GetWindowRect(source.Handle, out var bounds)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var width = bounds.Right - bounds.Left;
        var height = bounds.Bottom - bounds.Top;
        if (width <= 0 || height <= 0) throw new InvalidOperationException("QA window bounds are empty.");
        var expected = captionResource is null ? (Drawing.Color?)null : ToDrawingColor(((SolidColorBrush)Ui.Brush(captionResource)).Color);
        var scale = source.CompositionTarget?.TransformToDevice.M22 ?? 1;
        Drawing.Bitmap? bitmap = null;
        Drawing.Color actual = Drawing.Color.Empty;
        foreach (var flags in captionResource is null ? new[] { 2u } : new[] { 2u, 0u })
        {
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var candidate = new Drawing.Bitmap(width, height);
                using (var graphics = Drawing.Graphics.FromImage(candidate))
                {
                    var context = graphics.GetHdc();
                    try { _ = DwmFlush(); if (!PrintWindow(source.Handle, context, flags)) { candidate.Dispose(); continue; } }
                    finally { graphics.ReleaseHdc(context); }
                }
                if (expected is { } color)
                {
                    actual = candidate.GetPixel(candidate.Width / 2, Math.Min(candidate.Height - 1, Math.Max(0, (int)(16 * scale))));
                    if (actual.R != color.R || actual.G != color.G || actual.B != color.B) { candidate.Dispose(); Thread.Sleep(16); continue; }
                }
                bitmap = candidate; break;
            }
            if (bitmap is not null) break;
        }
        if (bitmap is null)
        {
            if (expected is { } color) throw new InvalidOperationException($"QA native caption pixels do not match theme: {captionResource}; expected {color}; actual {actual.R:X2}{actual.G:X2}{actual.B:X2}; scale {scale}");
            throw new Win32Exception(Marshal.GetLastWin32Error(), "QA native window capture failed.");
        }
        using (bitmap) bitmap.Save(file, Drawing.Imaging.ImageFormat.Png);
    }
    private static Drawing.Color ToDrawingColor(System.Windows.Media.Color color) => Drawing.Color.FromArgb(color.A, color.R, color.G, color.B);

    private sealed class RegionHandle : IDisposable
    {
        private readonly IntPtr _region;
        public int Width { get; }
        public int Height { get; }
        public bool IsPresent { get; }
        public bool IsEmpty => !IsPresent;
        public RegionHandle(IntPtr window)
        {
            if (!GetWindowRect(window, out var bounds)) return;
            Width = bounds.Right - bounds.Left; Height = bounds.Bottom - bounds.Top;
            _region = CreateRectRgn(0, 0, Width, Height); IsPresent = _region != IntPtr.Zero && GetWindowRgn(window, _region) != 0;
        }
        public RegionHandle(IntPtr window, int width, int height)
        {
            Width = width; Height = height; _region = CreateRectRgn(0, 0, width, height); IsPresent = _region != IntPtr.Zero && GetWindowRgn(window, _region) != 0;
        }
        public bool Contains(int x, int y) => IsPresent && PtInRegion(_region, x, y);
        public void Dispose() { if (_region != IntPtr.Zero) DeleteObject(_region); }
    }
}
