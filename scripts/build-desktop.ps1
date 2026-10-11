param([string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\native'))
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $projectRoot 'release\邻传-Windows免安装版'
$manifestPath = Join-Path $packageRoot 'manifest.json'
if (!(Test-Path -LiteralPath $manifestPath)) { throw '请先运行 npm run build 和 npm run package。' }
Add-Type -AssemblyName System.IO.Compression
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$zipPath = Join-Path $projectRoot 'build\desktop-payload.zip'
$file = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
$archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create)
try {
  $entry = $archive.CreateEntry('manifest.json')
  $stream = $entry.Open()
  try { $bytes = [IO.File]::ReadAllBytes($manifestPath); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  foreach ($property in $manifest.files.psobject.Properties) {
    $relative = [string]$property.Name
    if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or ($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') })) { throw "不安全路径：$relative" }
    $source = [IO.Path]::GetFullPath((Join-Path $packageRoot $relative))
    if (!$source.StartsWith([IO.Path]::GetFullPath($packageRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'payload 路径越界。' }
    if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'payload 不能包含链接。' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne [string]$property.Value) { throw "payload 哈希不匹配：$relative" }
    $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open(); $input = [IO.File]::OpenRead($source)
    try { $input.CopyTo($stream) } finally { $input.Dispose(); $stream.Dispose() }
  }
} finally { $archive.Dispose(); $file.Dispose() }
Push-Location $projectRoot
try {
  node scripts/desktop-assets.mjs
  if ($LASTEXITCODE -ne 0) { throw '桌面资源生成失败。' }
  dotnet restore native/Linchuan.Desktop/Linchuan.Desktop.csproj -r win-x64
  if ($LASTEXITCODE -ne 0) { throw '桌面依赖恢复失败。' }
  $assets = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'native\Linchuan.Desktop\obj\project.assets.json') | ConvertFrom-Json
  $notices = [Collections.Generic.List[string]]::new()
  foreach ($framework in $assets.project.frameworks.psobject.Properties.Value) {
    foreach ($dependency in $framework.downloadDependencies) {
      if ($dependency.name -notin @('Microsoft.NETCore.App.Runtime.win-x64', 'Microsoft.WindowsDesktop.App.Runtime.win-x64')) { continue }
      $version = ([regex]::Match($dependency.version, '^\[([^,]+)')).Groups[1].Value
      $package = $null
      foreach ($folder in $assets.packageFolders.psobject.Properties.Name) {
        $candidate = Join-Path $folder ($dependency.name.ToLowerInvariant() + '\' + $version)
        if (Test-Path -LiteralPath $candidate) { $package = $candidate; break }
      }
      if (!$package) { throw "未找到运行时许可：$($dependency.name) $version" }
      foreach ($license in @('LICENSE', 'LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT')) {
        $path = Join-Path $package $license
        if (Test-Path -LiteralPath $path) { $notices.Add("--- $($dependency.name) $version / $license ---`n" + [IO.File]::ReadAllText($path)) }
      }
    }
  }
  if ($notices.Count -lt 2) { throw '运行时许可不完整。' }
  [IO.File]::WriteAllText((Join-Path $projectRoot 'native\Linchuan.Desktop\Assets\DOTNET-NOTICES.txt'), ($notices -join "`n`n"))
  dotnet publish native/Linchuan.Desktop/Linchuan.Desktop.csproj -c Release -r win-x64 --self-contained true -o $OutputDir
  if ($LASTEXITCODE -ne 0) { throw '桌面程序构建失败。' }
  Get-FileHash -LiteralPath (Join-Path $OutputDir 'Linchuan.exe') -Algorithm SHA256
} finally { Pop-Location }
