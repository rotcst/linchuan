using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Reflection;

namespace Linchuan.Desktop;

public static class Ui
{
    public static Brush Brush(string key) => (Brush)Application.Current.Resources[key];
    public static TextBlock Text(string text, double size = 14, string brush = "Text")
    {
        var element = new TextBlock { Text = L.T(text), FontSize = size, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
        element.SetResourceReference(TextBlock.ForegroundProperty, brush);
        element.SetResourceReference(TextBlock.FontFamilyProperty, "Font");
        return element;
    }
    public static Border Border(UIElement child, string brush = "Surface", double padding = 12, double radius = 7)
    {
        var border = new Border { Child = child, Padding = new Thickness(padding), CornerRadius = new CornerRadius(radius), BorderThickness = new Thickness(1) };
        border.SetResourceReference(System.Windows.Controls.Border.BackgroundProperty, brush);
        border.SetResourceReference(System.Windows.Controls.Border.BorderBrushProperty, "Border");
        return border;
    }
    public static Button Button(string label, Action action, string? id = null, bool primary = false)
    {
        var button = new Button { Content = Text(label, 13, primary ? "OnAccent" : "Text"), Padding = new Thickness(12, 5, 12, 5), Height = 34, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Cursor = System.Windows.Input.Cursors.Hand, FocusVisualStyle = null };
        button.SetResourceReference(Control.BackgroundProperty, primary ? "Accent" : "Field");
        button.SetResourceReference(Control.BorderBrushProperty, "Border");
        var frame = new FrameworkElementFactory(typeof(Border));
        frame.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new CornerRadius(7));
        frame.SetBinding(System.Windows.Controls.Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        frame.SetBinding(System.Windows.Controls.Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        frame.SetBinding(System.Windows.Controls.Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        var content = new FrameworkElementFactory(typeof(ContentPresenter));
        content.SetBinding(FrameworkElement.MarginProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        content.SetBinding(FrameworkElement.HorizontalAlignmentProperty, new System.Windows.Data.Binding("HorizontalContentAlignment") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
        frame.AppendChild(content);
        var template = new ControlTemplate(typeof(Button)) { VisualTree = frame };
        var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension("Accent")));
        template.Triggers.Add(hover);
        var disabled = new Trigger { Property = UIElement.IsEnabledProperty, Value = false };
        disabled.Setters.Add(new Setter(UIElement.OpacityProperty, .45)); template.Triggers.Add(disabled);
        button.Template = template;
        button.Click += (_, _) => action();
        if (id is not null) AutomationProperties.SetAutomationId(button, id);
        return button;
    }
    public static Button AsyncButton(string label, Func<Task> action, string? id = null, bool primary = false)
    {
        Button? button = null;
        button = Button(label, async () => { button!.IsEnabled = false; try { await action(); } finally { button.IsEnabled = true; } }, id, primary);
        return button;
    }
    public static TextBox Input(string text = "", string? id = null, bool multiline = false)
    {
        var input = new TextBox { Text = text, FontSize = 14, Padding = new Thickness(10, 8, 10, 8), BorderThickness = new Thickness(1), FocusVisualStyle = null, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, HorizontalContentAlignment = HorizontalAlignment.Left, TextAlignment = TextAlignment.Left, VerticalContentAlignment = VerticalAlignment.Center };
        input.SetResourceReference(Control.BackgroundProperty, "Field"); input.SetResourceReference(Control.ForegroundProperty, "Text"); input.SetResourceReference(Control.BorderBrushProperty, "Border"); input.SetResourceReference(Control.FontFamilyProperty, "Font");
        var frame = new FrameworkElementFactory(typeof(Border)); frame.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new CornerRadius(7));
        foreach (var (property, name) in new[] { (System.Windows.Controls.Border.BackgroundProperty, "Background"), (System.Windows.Controls.Border.BorderBrushProperty, "BorderBrush"), (System.Windows.Controls.Border.BorderThicknessProperty, "BorderThickness") }) frame.SetBinding(property, new System.Windows.Data.Binding(name) { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        var content = new FrameworkElementFactory(typeof(ScrollViewer), "PART_ContentHost"); content.SetBinding(ScrollViewer.VerticalScrollBarVisibilityProperty, new System.Windows.Data.Binding("VerticalScrollBarVisibility") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) }); content.SetValue(ScrollViewer.HorizontalScrollBarVisibilityProperty, ScrollBarVisibility.Hidden); frame.AppendChild(content); input.Template = new ControlTemplate(typeof(TextBox)) { VisualTree = frame };
        input.GotKeyboardFocus += (_, _) => input.SetResourceReference(Control.BorderBrushProperty, "Accent");
        input.LostKeyboardFocus += (_, _) => input.SetResourceReference(Control.BorderBrushProperty, "Border");
        if (id is not null) AutomationProperties.SetAutomationId(input, id);
        return input;
    }
    public static Button Menu(string label, IEnumerable<(string Label, Action Action)> choices, string? id = null)
    {
        var button = Button("", () => { }, id); button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        var triggerContent = new Grid(); triggerContent.ColumnDefinitions.Add(new ColumnDefinition()); triggerContent.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var triggerLabel = Text(label, 13); triggerLabel.TextWrapping = TextWrapping.NoWrap; triggerLabel.TextTrimming = TextTrimming.CharacterEllipsis; triggerLabel.HorizontalAlignment = HorizontalAlignment.Left;
        var arrow = Text("⌄", 13, "Muted"); arrow.Margin = new Thickness(12, 0, 0, 0); arrow.HorizontalAlignment = HorizontalAlignment.Right; Grid.SetColumn(arrow, 1); triggerContent.Children.Add(triggerLabel); triggerContent.Children.Add(arrow); button.Content = triggerContent;
        var menuPadding = Theme.Number("select-menu-padding", 5);
        var optionHeight = Theme.Number("select-option-height", 44);
        var optionRadius = Theme.Number("select-option-radius", 5);
        var optionInset = Theme.Number("space-1", 4) / 2;
        var optionContentInset = Theme.Number("space-2", 8);
        var menu = new ContextMenu { Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom, PlacementTarget = button, Padding = new Thickness(menuPadding), MinWidth = 160, HasDropShadow = false };
        menu.SetResourceReference(Control.BackgroundProperty, "Surface"); menu.SetResourceReference(Control.ForegroundProperty, "Text"); menu.SetResourceReference(Control.BorderBrushProperty, "Border"); menu.SetResourceReference(Control.FontFamilyProperty, "Font");
        var menuFrame = new FrameworkElementFactory(typeof(Border)); menuFrame.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new CornerRadius(Theme.Number("select-radius", 7))); menuFrame.SetValue(System.Windows.Controls.Border.BorderThicknessProperty, new Thickness(1));
        foreach (var (property, name) in new[] { (System.Windows.Controls.Border.BackgroundProperty, "Background"), (System.Windows.Controls.Border.BorderBrushProperty, "BorderBrush") }) menuFrame.SetBinding(property, new System.Windows.Data.Binding(name) { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        var items = new FrameworkElementFactory(typeof(ItemsPresenter)); items.SetValue(FrameworkElement.MarginProperty, new Thickness(menuPadding)); menuFrame.AppendChild(items); menu.Template = new ControlTemplate(typeof(ContextMenu)) { VisualTree = menuFrame };
        foreach (var (name, action) in choices)
        {
            object header = L.T(name); var language = name switch { "简体中文" => "zh", "English" => "en", "한국어" => "ko", "日本語" => "ja", _ => null }; if (language is not null) header = Row(Flag(language), Text(name));
            var item = new MenuItem { Header = header, Height = optionHeight, Padding = new Thickness(0), FocusVisualStyle = null };
            var itemStyle = new Style(typeof(MenuItem)); itemStyle.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension("Surface"))); itemStyle.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension("Text"))); item.Style = itemStyle;
            var frame = new FrameworkElementFactory(typeof(Border)); frame.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new CornerRadius(optionRadius)); frame.SetValue(FrameworkElement.MarginProperty, new Thickness(optionInset));
            frame.SetBinding(System.Windows.Controls.Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(ContentPresenter.ContentSourceProperty, "Header"); presenter.SetValue(FrameworkElement.MarginProperty, new Thickness(optionContentInset, 0, optionContentInset, 0)); presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center); frame.AppendChild(presenter);
            var template = new ControlTemplate(typeof(MenuItem)) { VisualTree = frame };
            foreach (var property in new[] { MenuItem.IsHighlightedProperty, UIElement.IsKeyboardFocusedProperty }) { var trigger = new Trigger { Property = property, Value = true }; trigger.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension("Selected"))); template.Triggers.Add(trigger); }
            item.Template = template;
            item.Click += (_, _) => action(); menu.Items.Add(item);
        }
        button.ContextMenu = menu;
        button.Click += (_, _) => menu.IsOpen = true;
        return button;
    }
    public static BitmapImage Bitmap(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes); var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.StreamSource = stream; bitmap.EndInit(); bitmap.Freeze(); return bitmap;
    }
    public static FrameworkElement Icon(string key)
    {
        var glyph = key switch { "computer" => "\uE770", "phone" => "\uE8EA", "chat" => "\uE8BD", "file" => "\uE8A5", "image" => "\uEB9F", "copy" => "\uE8C8", "delete" => "\uE74D", "download" => "\uE896", "settings" => "\uE713", "attach" => "\uE723", _ => "\uE72A" };
        var text = Text(glyph, 20); text.FontFamily = new FontFamily("Segoe MDL2 Assets"); return text;
    }
    public static FrameworkElement Flag(string language)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("assets." + language + ".png");
        if (stream is null) return Text(language);
        using var bytes = new MemoryStream(); stream.CopyTo(bytes);
        return new Image { Source = Bitmap(bytes.ToArray()), Width = 22, Height = 22, Stretch = Stretch.UniformToFill, Clip = new EllipseGeometry(new Point(11, 11), 11, 11) };
    }
    public static void InstallScrollBars()
    {
        var frame = new FrameworkElementFactory(typeof(Grid)); frame.SetValue(Panel.BackgroundProperty, Brushes.Transparent);
        var track = new FrameworkElementFactory(typeof(NativeScrollTrack), "PART_Track"); track.SetValue(Track.OrientationProperty, Orientation.Vertical); track.SetValue(Track.IsDirectionReversedProperty, true);
        foreach (var (property, name) in new[] { (Track.MinimumProperty, "Minimum"), (Track.MaximumProperty, "Maximum"), (Track.ValueProperty, "Value"), (Track.ViewportSizeProperty, "ViewportSize") }) track.SetBinding(property, new System.Windows.Data.Binding(name) { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent), Mode = System.Windows.Data.BindingMode.TwoWay });
        frame.AppendChild(track); var style = new Style(typeof(ScrollBar)); style.Setters.Add(new Setter(FrameworkElement.WidthProperty, 10d)); style.Setters.Add(new Setter(Control.TemplateProperty, new ControlTemplate(typeof(ScrollBar)) { VisualTree = frame })); Application.Current.Resources[typeof(ScrollBar)] = style;
    }
    public static StackPanel Row(params UIElement[] children) { var row = new SpacedRow(); foreach (var child in children) row.Children.Add(child); return row; }
}

public sealed class SpacedRow : StackPanel
{
    public double Gap { get; set; } = 12;
    public SpacedRow() { Orientation = Orientation.Horizontal; }
    protected override void OnVisualChildrenChanged(DependencyObject visualAdded, DependencyObject visualRemoved)
    {
        base.OnVisualChildrenChanged(visualAdded, visualRemoved);
        for (var index = 0; index < Children.Count; index++) if (Children[index] is FrameworkElement element) element.Margin = new Thickness(element.Margin.Left, element.Margin.Top, index < Children.Count - 1 ? Gap : 0, element.Margin.Bottom);
    }
}

public sealed class NativeScrollTrack : Track
{
    public NativeScrollTrack()
    {
        var border = new FrameworkElementFactory(typeof(Border)); border.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new CornerRadius(4)); border.SetResourceReference(System.Windows.Controls.Border.BackgroundProperty, "Offline"); border.SetValue(FrameworkElement.MarginProperty, new Thickness(2, 0, 2, 0));
        Thumb = new Thumb { Template = new ControlTemplate(typeof(Thumb)) { VisualTree = border } };
        RepeatButton Area(System.Windows.Input.RoutedCommand command) { var element = new FrameworkElementFactory(typeof(Border)); element.SetValue(System.Windows.Controls.Border.BackgroundProperty, Brushes.Transparent); return new RepeatButton { Command = command, Template = new ControlTemplate(typeof(RepeatButton)) { VisualTree = element }, Focusable = false }; }
        DecreaseRepeatButton = Area(ScrollBar.PageUpCommand); IncreaseRepeatButton = Area(ScrollBar.PageDownCommand);
    }
}
