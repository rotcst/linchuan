param(
  [string]$ReleaseDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\邻传-Windows免安装版'),
  [string]$Output = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\Linchuan.exe')
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Native = Join-Path $Root 'native'
$manifestPath = Join-Path $ReleaseDir 'manifest.json'
if (!(Test-Path -LiteralPath $manifestPath)) { throw '找不到发布 manifest.json，请先运行 npm run package。' }
if (!(Test-Path -LiteralPath (Join-Path $Native 'LinchuanLauncher.cs'))) { throw '找不到启动器源码。' }

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$releaseRoot = [IO.Path]::GetFullPath($ReleaseDir).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$stage = [IO.Path]::GetFullPath((Join-Path $tempRoot ('linchuan-launcher-' + [Guid]::NewGuid().ToString('N'))))
if (!$stage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or $stage -match '\.\.') { throw '临时构建目录不在系统临时目录内。' }
$payload = Join-Path $stage 'payload'
$zip = Join-Path $stage 'payload.zip'
New-Item -ItemType Directory -Force -Path $payload | Out-Null
if ((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '临时构建目录不能是 reparse point。' }
try {
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $payload 'manifest.json')
  foreach ($property in $manifest.files.psobject.Properties) {
    $relative = [string]$property.Name
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or $relative -match '^[A-Za-z]:') {
      throw "manifest 包含不安全路径：$relative"
    }
    $source = [IO.Path]::GetFullPath((Join-Path $ReleaseDir ($relative -replace '/', '\\')))
    if (!$source.StartsWith($releaseRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "manifest 路径越界：$relative" }
    $target = Join-Path $payload ($relative -replace '/', '\\')
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "manifest 文件不存在：$relative" }
    if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "拒绝读取 reparse point：$relative" }
    $targetParent = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
  }
  Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $zip -CompressionLevel Optimal
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (!(Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (!(Test-Path -LiteralPath $csc)) { throw '找不到 .NET Framework 4.x csc.exe。' }
  $outputDir = Split-Path -Parent $Output
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  & $csc /nologo /target:winexe /platform:anycpu /optimize+ /warn:4 `
    /out:$Output /resource:$zip,payload.zip `
    /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
    (Join-Path $Native 'LinchuanLauncher.cs')
  if ($LASTEXITCODE -ne 0) { throw "启动器编译失败：$LASTEXITCODE" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Output).Hash.ToLowerInvariant()
  "launcher=$Output"
  "sha256=$hash"
  "payload_files=$(@($manifest.files.psobject.Properties).Count)"
} finally {
  $resolvedStage = [IO.Path]::GetFullPath($stage)
  $stageItem = if (Test-Path -LiteralPath $stage) { Get-Item -LiteralPath $stage } else { $null }
  if ($resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      $resolvedStage -ne $tempRoot -and $stageItem -and
      (($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
