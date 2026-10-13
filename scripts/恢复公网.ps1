param([string]$ExpectedPackageHash, [string]$ExpectedProgramHash, [string]$ExpectedNodeHash, [switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Windows.Forms

function Assert-SafePath([string]$path) {
  $current = [IO.Path]::GetFullPath($path)
  if ($current.StartsWith('\\')) { throw '恢复工具不在网络路径中直接运行，请先复制到新主机。' }
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '恢复路径包含链接，已停止。' }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if (!$parent -or $parent -eq $current) { break }
    $current = $parent
  }
}
function Get-Sha256([string]$path) {
  Assert-SafePath $path
  $algorithm = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead($path)
  try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  return $actual
}
function Assert-Hash([string]$path, [string]$hash) {
  $actual = Get-Sha256 $path
  if ($hash -notmatch '^[a-f0-9]{64}$' -or $actual -ne $hash) { throw '恢复文件完整性校验失败。' }
}
function Set-AtomicFile([string]$temporary, [string]$destination) {
  Assert-SafePath $temporary; Assert-SafePath $destination
  if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary, $destination, [NullString]::Value) }
  else { [IO.File]::Move($temporary, $destination) }
}

$plain = $null; $cipher = $null; $configTemp = $null; $tokenTemp = $null; $backup = $null
$committed = $false; $rollbackComplete = $false; $tokenChanged = $false; $configChanged = $false; $configAttempted = $false
try {
  $root = Join-Path $env:LOCALAPPDATA 'Linchuan'
  $preferencesPath = Join-Path $root 'desktop\ui.json'; Assert-SafePath $preferencesPath
  $preferences = Get-Content -Raw -LiteralPath $preferencesPath | ConvertFrom-Json
  if ($preferences.Hosting -ne $true -or !$preferences.DeviceId) { throw '请在当前服务主机运行；普通客户端不能恢复通道。' }
  $dataDir = if ($preferences.HostDataDir) { [IO.Path]::GetFullPath($preferences.HostDataDir) } else { Join-Path $root 'data' }
  Assert-SafePath $dataDir
  $port = [int]$preferences.HostPort
  if ($port -lt 1024 -or $port -gt 65535) { throw '服务端口无效。' }
  $node = Join-Path $root 'app\runtime\node.exe'
  $program = Join-Path $PSScriptRoot '恢复公网.cjs'
  $package = Join-Path $PSScriptRoot '公网恢复包.json'
  Assert-Hash $node $ExpectedNodeHash; Assert-Hash $program $ExpectedProgramHash; Assert-Hash $package $ExpectedPackageHash
  $processInfo = New-Object Diagnostics.ProcessStartInfo
  $processInfo.FileName = $node; $processInfo.UseShellExecute = $false; $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardOutput = $true; $processInfo.RedirectStandardError = $true
  $processInfo.EnvironmentVariables['LINCHUAN_RECOVERY_PIPE'] = '1'
  $processInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $processInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  $arguments = @($program, 'decrypt', $package, $dataDir, [string]$preferences.DeviceId, [string]$port, $ExpectedPackageHash)
  $processInfo.Arguments = ($arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $process = New-Object Diagnostics.Process; $process.StartInfo = $processInfo
  try {
    [void]$process.Start()
    $output = $process.StandardOutput.ReadToEndAsync(); $errors = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(20000)) { $process.Kill(); throw '恢复验证超时。' }
    if ($process.ExitCode -ne 0) { throw '恢复包无法在这台主机解密；设备组、身份、端口或有效期不匹配。' }
    $result = $output.GetAwaiter().GetResult() | ConvertFrom-Json
    [void]$errors.GetAwaiter().GetResult()
  } finally { $process.Dispose() }
  $configPath = Join-Path $dataDir 'cloudflare.json'; $tokenPath = Join-Path $dataDir 'tunnel-token.dpapi'
  Assert-SafePath $configPath; Assert-SafePath $tokenPath
  $backup = Join-Path $dataDir ('public-recovery-backup-' + [Guid]::NewGuid().ToString('N'))
  Assert-SafePath $backup; [void][IO.Directory]::CreateDirectory($backup)
  $hadConfig = Test-Path -LiteralPath $configPath; $hadToken = Test-Path -LiteralPath $tokenPath
  if ($hadConfig) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $backup 'cloudflare.json') }
  if ($hadToken) { Copy-Item -LiteralPath $tokenPath -Destination (Join-Path $backup 'tunnel-token.dpapi') }
  $plain = [Text.Encoding]::UTF8.GetBytes([string]$result.token)
  $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $tokenTemp = $tokenPath + '.recovery-' + [Guid]::NewGuid().ToString('N')
  $configTemp = $configPath + '.recovery-' + [Guid]::NewGuid().ToString('N')
  Assert-SafePath $tokenTemp; Assert-SafePath $configTemp
  [IO.File]::WriteAllBytes($tokenTemp, $cipher)
  [IO.File]::WriteAllText($configTemp, ($result.configuration | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
  try {
    Set-AtomicFile $tokenTemp $tokenPath
    $tokenChanged = $true
    $configAttempted = $true
    Set-AtomicFile $configTemp $configPath
    $configChanged = $true
    $committed = $true
  } catch {
    if ($configAttempted) {
      $configChanged = if ($hadConfig) { !(Test-Path -LiteralPath $configPath) -or (Get-Sha256 $configPath) -ne (Get-Sha256 (Join-Path $backup 'cloudflare.json')) } else { Test-Path -LiteralPath $configPath }
    }
    if ($tokenChanged -and $hadToken) { Copy-Item -LiteralPath (Join-Path $backup 'tunnel-token.dpapi') -Destination $tokenPath -Force }
    elseif ($tokenChanged -and (Test-Path -LiteralPath $tokenPath)) { Remove-Item -LiteralPath $tokenPath -Force }
    if ($configChanged -and $hadConfig) { Copy-Item -LiteralPath (Join-Path $backup 'cloudflare.json') -Destination $configPath -Force }
    elseif ($configChanged -and (Test-Path -LiteralPath $configPath)) { Remove-Item -LiteralPath $configPath -Force }
    $rollbackComplete = $true
    throw
  }
  $message = "公网配置已恢复，凭据已用当前 Windows 用户重新加密。聊天数据库和文件未修改。`r`n`r`n请从系统托盘选择退出邻传，再重新运行邻传（建议 1.2.1）。`r`n等待右侧显示互联网通道已连接。"
  try { [IO.File]::WriteAllText((Join-Path $PSScriptRoot '恢复结果.txt'), $message, [Text.UTF8Encoding]::new($true)) } catch { }
  if ($NonInteractive) { Write-Output '公网配置恢复完成。' }
  else { [void][Windows.Forms.MessageBox]::Show($message, '邻传公网恢复完成') }
} catch {
  if ($committed) { Write-Output '公网配置已恢复；请从托盘退出后重新启动邻传。'; exit 0 }
  if ($NonInteractive) { Write-Error $_.Exception.Message }
  else { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, '邻传公网恢复失败') }
  exit 1
} finally {
  if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($cipher) { [Array]::Clear($cipher, 0, $cipher.Length) }
  $result = $null
  foreach ($temporary in @($configTemp, $tokenTemp)) { if ($temporary -and (Test-Path -LiteralPath $temporary)) { Assert-SafePath $temporary; Remove-Item -LiteralPath $temporary -Force } }
  if ($backup -and ($committed -or $rollbackComplete -or (!$tokenChanged -and !$configChanged))) {
    try {
      Assert-SafePath $backup
      foreach ($name in @('cloudflare.json', 'tunnel-token.dpapi')) { $backupFile = Join-Path $backup $name; Assert-SafePath $backupFile; if (Test-Path -LiteralPath $backupFile) { Remove-Item -LiteralPath $backupFile -Force } }
      [IO.Directory]::Delete($backup)
    } catch { }
  }
}
