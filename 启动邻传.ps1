param([switch]$Internet, [switch]$Local)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Add-Type -AssemblyName System.Windows.Forms
try {
    $runtimePath = Join-Path $PSScriptRoot 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $runtimePath)) {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw '未找到 Node.js。请使用包含运行时的 Windows 免安装版。' }
        $runtimePath = $nodeCommand.Source
    }
    $serverPath = Join-Path $PSScriptRoot 'build\server.cjs'
    if (-not (Test-Path -LiteralPath $serverPath)) { throw '未找到构建文件，请先构建或使用 Windows 免安装版。' }
    $configured = (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data\cloudflare.json')) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data\tunnel-token.dpapi'))
    if ($Internet -and -not $configured) { throw '请先运行 scripts\配置固定域名.cmd，在本地输入 DNS Token。' }
    $useInternet = $Internet -and -not $Local
    $existing = $null
    try { $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:3939/api/info' -TimeoutSec 2 } catch { }
    if ($existing -and $existing.serverName -eq '邻传') {
        if ($useInternet -and -not $existing.publicUrl) { throw '当前服务仅使用局域网，请在本机网页中停止服务后重新启动。' }
        Start-Process 'http://127.0.0.1:3939'
        exit 0
    }
    $dataPath = Join-Path $PSScriptRoot 'data'
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    $env:DATA_DIR = $dataPath
    $env:OPEN_BROWSER = '0'
    $env:INTERNET = if ($useInternet) { '1' } else { '0' }
    $nodeProcess = Start-Process -FilePath $runtimePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'service.log') -RedirectStandardError (Join-Path $dataPath 'service-error.log') -PassThru
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 200
        try {
            $ready = Invoke-RestMethod -Uri 'http://127.0.0.1:3939/api/info' -TimeoutSec 1
            if ($ready.serverName -eq '邻传') { Start-Process 'http://127.0.0.1:3939'; exit 0 }
        } catch { }
        if ($nodeProcess.HasExited) { throw '服务启动失败，请查看 data\service-error.log。' }
    }
    throw '服务启动超时，请查看 data\service-error.log。'
} catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '邻传启动失败', 'OK', 'Error') | Out-Null
    exit 1
}
