param([string]$Exe = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\native\Linchuan.exe'), [string]$Evidence = (Join-Path (Split-Path -Parent $PSScriptRoot) 'qa\native'))
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativePackageContext {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref int length, StringBuilder name);
  public static bool IsPackaged() { var length = 512; return GetCurrentPackageFullName(ref length, new StringBuilder(length)) != 15700; }
}
'@

$evidenceRoot = [IO.Path]::GetFullPath($Evidence)
function Assert-NoReparsePath([string]$path) {
  $current = [IO.Path]::GetFullPath($path)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "拒绝使用 reparse 路径: $current" }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if (!$parent -or $parent -eq $current) { break }
    $current = $parent
  }
}
Assert-NoReparsePath $evidenceRoot
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Assert-NoReparsePath $evidenceRoot
$runRoot = Join-Path $evidenceRoot ('.run-' + [Guid]::NewGuid().ToString('N'))
$shortcut = Join-Path $evidenceRoot ('.native-qa-' + [Guid]::NewGuid().ToString('N') + '.lnk')
$report = Join-Path $evidenceRoot 'verification.json'
$pidFile = $report + '.pid'
$progressFile = $report + '.progress'
$packaged = [NativePackageContext]::IsPackaged()
$qaPid = $null
$launch = $null
$shortcutObject = $null

function Quote-Argument([string]$value) { return '"' + $value.Replace('"', '\"') + '"' }
function Assert-CleanupPath([string]$path, [string]$root) {
  $absolute = [IO.Path]::GetFullPath($path)
  $rootAbsolute = [IO.Path]::GetFullPath($root)
  $prefix = $rootAbsolute.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (!$absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $absolute -eq $rootAbsolute) { throw '拒绝清理越界路径。' }
  Assert-NoReparsePath $absolute
  if (Test-Path -LiteralPath $absolute) {
    $item = Get-Item -LiteralPath $absolute -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '拒绝清理 reparse 路径。' }
    $links = Get-ChildItem -LiteralPath $absolute -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    if ($links) { throw '测试目录存在链接，保留以供检查。' }
  }
}
function Stop-OwnedQaProcess([int]$id, [string]$expectedExe, [string]$expectedReport) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if (!$process -or !$process.ExecutablePath -or !$process.CommandLine) { return }
  $exeMatch = [IO.Path]::GetFullPath($process.ExecutablePath) -eq [IO.Path]::GetFullPath($expectedExe)
  $reportPattern = '(?i)(^|\s)"?' + [Regex]::Escape([IO.Path]::GetFullPath($expectedReport)) + '"?(\s|$)'
  $reportMatch = $process.CommandLine -match $reportPattern
  $verifyMatch = $process.CommandLine -match '(?i)(^|\s)"?--verify"?(\s|$)'
  if ($exeMatch -and $reportMatch -and $verifyMatch) {
    $owned = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($owned) { & (Join-Path $env:WINDIR 'System32\taskkill.exe') /PID $id /T /F | Out-Null }
  }
}

New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
Assert-NoReparsePath $runRoot
$qaDataDir = Join-Path $runRoot 'data'
New-Item -ItemType Directory -Path $qaDataDir -Force | Out-Null
@{ publicUrl = 'https://transfer.example.test' } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $qaDataDir 'cloudflare.json') -Encoding UTF8
$candidateHash = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
if (Test-Path -LiteralPath $report) { Assert-CleanupPath $report $evidenceRoot; Remove-Item -LiteralPath $report -Force }
if (Test-Path -LiteralPath $pidFile) { Assert-CleanupPath $pidFile $evidenceRoot; Remove-Item -LiteralPath $pidFile -Force }
if (Test-Path -LiteralPath $progressFile) { Assert-CleanupPath $progressFile $evidenceRoot; Remove-Item -LiteralPath $progressFile -Force }
Assert-NoReparsePath $runRoot
for ($attempt = 0; ; $attempt++) {
  $portListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 0)
  $portListener.Start(); $port = $portListener.LocalEndpoint.Port
  $tlsPort = if ($port -eq 65535) { 65534 } else { $port + 1 }
  $tlsListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $tlsPort)
  try { $tlsListener.Start(); break }
  catch [Net.Sockets.SocketException] { if ($attempt -ge 10) { throw } }
  finally { $tlsListener.Stop(); $portListener.Stop() }
}
$qaArguments = @('--app-dir', (Join-Path $runRoot 'app'), '--data-dir', (Join-Path $runRoot 'data'), '--client-dir', (Join-Path $runRoot 'desktop'), '--port', [string]$port, '--local', '--verify', $report)
$argumentText = ($qaArguments | ForEach-Object { Quote-Argument $_ }) -join ' '

try {
  if ($packaged) {
    $shortcutObject = New-Object -ComObject WScript.Shell
    $link = $shortcutObject.CreateShortcut($shortcut)
    $link.TargetPath = [IO.Path]::GetFullPath($Exe)
    $link.Arguments = $argumentText
    $link.WorkingDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Exe))
    $link.WindowStyle = 1
    $link.Save()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($link) | Out-Null
    $link = $null
    $launch = Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList (Quote-Argument $shortcut) -WindowStyle Hidden -PassThru
  } else {
    $launch = Start-Process -FilePath $Exe -ArgumentList $argumentText -WindowStyle Hidden -PassThru
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while ([DateTime]::UtcNow -lt $deadline) {
    $earlyFailure = $null
    if (Test-Path -LiteralPath $report) {
      try {
        $earlyFailure = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json -ErrorAction Stop
      } catch {
        $earlyFailure = $null
      }
    }
    if ($earlyFailure -and $earlyFailure.PSObject.Properties.Name -contains 'passed' -and $earlyFailure.passed -eq $false) {
      Get-Content -LiteralPath $report
      $startupError = Join-Path $qaDataDir 'native-backend.stderr.log'
      if (Test-Path -LiteralPath $startupError) { Get-Content -LiteralPath $startupError -Tail 30 }
      throw '原生客户端回归未通过。'
    }
    if (!$qaPid -and (Test-Path -LiteralPath $pidFile)) {
      $candidatePid = [int](Get-Content -Raw -LiteralPath $pidFile)
      if ($candidatePid -gt 0) { $qaPid = $candidatePid }
    }
    if ($qaPid) {
      $running = Get-Process -Id $qaPid -ErrorAction SilentlyContinue
      if (!$running) { break }
    } elseif (!$packaged -and $launch.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }
  if (!$qaPid) { throw '原生客户端未写入 QA PID。' }
  if (Get-Process -Id $qaPid -ErrorAction SilentlyContinue) { throw '原生客户端验证超时。' }
  if (!(Test-Path -LiteralPath $report)) { throw '原生验证未生成报告。' }
  $result = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
  if (!$result.passed) { Get-Content -LiteralPath $report; throw '原生客户端回归未通过。' }
  $result | Add-Member -NotePropertyName artifactSha256 -NotePropertyValue $candidateHash
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $report -Encoding UTF8
  Get-Content -LiteralPath $report
  if (Test-Path -LiteralPath $progressFile) { Assert-CleanupPath $progressFile $evidenceRoot; Remove-Item -LiteralPath $progressFile -Force }
} finally {
  if ($qaPid) { Stop-OwnedQaProcess $qaPid $Exe $report }
  if (Test-Path -LiteralPath $pidFile) { Assert-CleanupPath $pidFile $evidenceRoot; Remove-Item -LiteralPath $pidFile -Force }
  if ($shortcutObject) { [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcutObject) | Out-Null }
  if (Test-Path -LiteralPath $shortcut) { Assert-CleanupPath $shortcut $evidenceRoot; Remove-Item -LiteralPath $shortcut -Force }
  Assert-CleanupPath $runRoot $evidenceRoot
  if (Test-Path -LiteralPath $runRoot) { Remove-Item -LiteralPath $runRoot -Recurse -Force }
}
