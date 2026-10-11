param([switch]$Elevated)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host '需要管理员权限，仅允许本地子网访问邻传 TCP 3939 端口。'
    $safeScript = $PSCommandPath.Replace('"', '')
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $safeScript + '" -Elevated'
    $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    exit $process.ExitCode
}
$ruleName = 'Linchuan-LAN-TCP-3939'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNodePath = Join-Path $taskRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $taskNodePath)) { $taskNodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$taskNodePath = [IO.Path]::GetFullPath($taskNodePath)
$rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($rule) {
    Set-NetFirewallRule -Name $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3939 -RemoteAddress LocalSubnet -Profile Private,Public -Program $taskNodePath -EdgeTraversalPolicy Block | Out-Null
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName '邻传 - 本地子网 TCP 3939' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3939 -RemoteAddress LocalSubnet -Profile Private,Public -Program $taskNodePath -EdgeTraversalPolicy Block | Out-Null
}
Write-Host '已允许同一子网的设备访问邻传。没有开启路由器端口转发。'
Write-Host '删除此规则：管理员 PowerShell 中运行 Remove-NetFirewallRule -Name Linchuan-LAN-TCP-3939'
