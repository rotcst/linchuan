param(
  [int]$Port = 3957,
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$checkRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('linchuan-launcher-check-' + [guid]::NewGuid().ToString('N'))))
$appDir = Join-Path $checkRoot 'app'
$dataDir = Join-Path $checkRoot 'data'
$exe = Join-Path $root 'release\Linchuan.exe'

function Assert-SafeTempRoot([string]$path) {
  $resolved = [IO.Path]::GetFullPath($path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $tempPrefix = $tempRoot + [IO.Path]::DirectorySeparatorChar
  if (!$resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "测试目录越界：$resolved" }
  if (Test-Path -LiteralPath $resolved) {
    $item = Get-Item -LiteralPath $resolved
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "测试目录不能是 reparse point：$resolved" }
  }
}

function Get-OwnedNode([int]$processId, [System.Diagnostics.Process]$launcher, [string]$appDir) {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
  $expected = [IO.Path]::GetFullPath((Join-Path $appDir 'runtime\node.exe'))
  if (!$info -or [IO.Path]::GetFullPath([string]$info.ExecutablePath) -ne $expected -or
      [int]$info.ParentProcessId -ne $launcher.Id) {
    throw "监听进程不是本次启动器创建的 Node：$processId"
  }
  return $info
}

function Stop-TestServer([System.Diagnostics.Process]$launcher, [int]$port, [int]$ownedPid, [switch]$RequireGraceful) {
  $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection -and $connection.OwningProcess -eq $ownedPid) {
    try {
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/api/host/stop" -Headers @{ 'X-Linchuan-Host' = '1' } -TimeoutSec 3 | Out-Null
    } catch { }
    Start-Sleep -Milliseconds 500
    $remaining = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($remaining -and $remaining.OwningProcess -eq $ownedPid -and !$RequireGraceful) {
      Stop-Process -Id $ownedPid -Force -ErrorAction SilentlyContinue
    }
  }
  if ($launcher -and !$launcher.HasExited) { Wait-Process -Id $launcher.Id -Timeout 15 -ErrorAction SilentlyContinue }
  if ($RequireGraceful -and (!$launcher.HasExited -or $launcher.ExitCode -ne 0)) {
    throw "服务未以正常退出码结束：$($launcher.ExitCode)"
  }
}

if (!(Test-Path -LiteralPath $exe)) { throw '找不到 release\Linchuan.exe，请先运行 build-launcher.ps1。' }
if (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue) { throw "测试端口已被占用：$Port" }
Assert-SafeTempRoot $checkRoot
New-Item -ItemType Directory -Force -Path $appDir, $dataDir | Out-Null
$launcher = $null
$ownedNodePid = 0
$oldJoinCode = $env:JOIN_CODE
$env:JOIN_CODE = '654321'
try {
  $arguments = @('--diagnostic', '--local', '--noBrowser', "--port=$Port", ('"--app-dir=' + $appDir + '"'), ('"--dataDir=' + $dataDir + '"'))
  $launcher = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/info" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (!$ready) { throw '启动器未在超时时间内提供 /api/info。' }
  $ownedConnection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
  if (!$ownedConnection) { throw '未找到测试服务监听连接。' }
  $ownedNodePid = [int]$ownedConnection.OwningProcess
  Get-OwnedNode $ownedNodePid $launcher $appDir | Out-Null
  if (!(Test-Path -LiteralPath (Join-Path $appDir 'build\server.cjs'))) { throw '服务文件未完成自解包。' }
  $appMarker = Join-Path $appDir 'user.keep'
  $dataMarker = Join-Path $dataDir 'user.keep'
  Set-Content -LiteralPath $appMarker -Value 'keep-app' -NoNewline
  Set-Content -LiteralPath $dataMarker -Value 'keep-data' -NoNewline
  Start-Sleep -Seconds 1
  $status = $null
  try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/session" -TimeoutSec 3 | Out-Null }
  catch { $status = $_.Exception.Response.StatusCode.value__ }
  if ($status -ne 401) { throw "延迟鉴权请求应返回 401，实际为 $status。" }
  if (!(Test-Path -LiteralPath (Join-Path $dataDir 'service.log'))) { throw '服务日志未创建。' }
  $joinHeaders = @{ Origin = "http://127.0.0.1:$Port" }
  $joinBody = @{ code = '654321'; name = '启动器持久化测试'; type = 'computer'; deviceId = 'launcher-client' } | ConvertTo-Json -Compress
  $joined = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/join" -Headers $joinHeaders -ContentType 'application/json' -Body $joinBody
  if (!$joined.token) { throw '隔离服务 join 未返回会话 token。' }
  $auth = @{ Authorization = "Bearer $($joined.token)"; Origin = "http://127.0.0.1:$Port" }
  $savedText = 'launcher persistence ' + [guid]::NewGuid().ToString('N')
  $saved = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/messages" -Headers $auth -ContentType 'application/json' -Body (@{ to = 'all'; text = $savedText; clientId = 'launcher-persist-1' } | ConvertTo-Json -Compress)
  if ($saved.text -ne $savedText) { throw '隔离服务未保存测试消息。' }

  $second = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
  if ($second.ExitCode -ne 0) { throw "二次启动检测失败，退出码：$($second.ExitCode)" }
  Stop-TestServer $launcher $Port $ownedNodePid -RequireGraceful
  $knownFile = Join-Path $appDir 'build\server.cjs'
  Set-Content -LiteralPath $knownFile -Value 'corrupt-test-payload' -NoNewline
  $launcher = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $updated = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/info" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $updated = $true; break }
    } catch { }
  }
  if (!$updated) { throw '更新启动未在超时时间内提供 /api/info。' }
  $updatedConnection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
  $ownedNodePid = [int]$updatedConnection.OwningProcess
  Get-OwnedNode $ownedNodePid $launcher $appDir | Out-Null
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'release\邻传-Windows免安装版\manifest.json') | ConvertFrom-Json
  $expectedHash = [string]$manifest.files.'build/server.cjs'
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $knownFile).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash.ToLowerInvariant()) { throw '已声明服务文件未在更新启动时恢复。' }
  $session = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/api/session" -Headers $auth
  if ($session.device.id -ne $joined.device.id) { throw '重启后会话设备身份未恢复。' }
  $history = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/api/messages?to=all" -Headers $auth
  if (!(@($history.messages) | Where-Object { $_.clientId -eq 'launcher-persist-1' -and $_.text -eq $savedText })) { throw '重启后未恢复隔离持久化消息。' }
  Stop-TestServer $launcher $Port $ownedNodePid -RequireGraceful
  if (!(Test-Path -LiteralPath $appMarker) -or (Get-Content -Raw $appMarker) -ne 'keep-app') { throw '二次启动覆盖了未知 app 文件。' }
  if (!(Test-Path -LiteralPath $dataMarker) -or (Get-Content -Raw $dataMarker) -ne 'keep-data') { throw '服务启动覆盖了未知 data 文件。' }
  Write-Output "PASS first=200 second=existing-service persisted-session=1 persisted-message=1 delayed401=1 graceful-stop=1 managed-update=1 preserve-unknown=1 port=$Port"
}
finally {
  if ($launcher -and !$launcher.HasExited -and $ownedNodePid) { Stop-TestServer $launcher $Port $ownedNodePid }
  if ($null -eq $oldJoinCode) { Remove-Item Env:JOIN_CODE -ErrorAction SilentlyContinue } else { $env:JOIN_CODE = $oldJoinCode }
  if (!$KeepTemp -and (Test-Path -LiteralPath $checkRoot)) {
    Assert-SafeTempRoot $checkRoot
    Remove-Item -LiteralPath $checkRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
