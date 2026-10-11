param(
  [switch]$NonInteractive,
  [string]$Hostname,
  [string]$ZoneId,
  [string]$TunnelName,
  [string]$WranglerPath
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$NativeAppDir = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Linchuan\app'))
$DataDir = if ($env:DATA_DIR) {
  [IO.Path]::GetFullPath($env:DATA_DIR)
} elseif ([IO.Path]::GetFullPath($Root).TrimEnd('\') -eq $NativeAppDir.TrimEnd('\')) {
  Join-Path (Split-Path -Parent $NativeAppDir) 'data'
} else {
  Join-Path $Root 'data'
}
$ExistingMetaPath = Join-Path $DataDir 'cloudflare.json'
$ExistingMeta = $null
if (Test-Path -LiteralPath $ExistingMetaPath) {
  try { $ExistingMeta = Get-Content -Raw -LiteralPath $ExistingMetaPath | ConvertFrom-Json } catch { $ExistingMeta = $null }
}
if (!$Hostname -and $env:LINCHUAN_PUBLIC_HOST) { $Hostname = $env:LINCHUAN_PUBLIC_HOST }
if (!$ZoneId -and $env:CLOUDFLARE_ZONE_ID) { $ZoneId = $env:CLOUDFLARE_ZONE_ID }
if (!$TunnelName -and $env:LINCHUAN_TUNNEL_NAME) { $TunnelName = $env:LINCHUAN_TUNNEL_NAME }
if (!$TunnelName) { $TunnelName = 'linchuan-home-transfer' }
if (!$Hostname -and $ExistingMeta.publicUrl) { try { $Hostname = ([Uri]$ExistingMeta.publicUrl).Host } catch { } }
if (!$ZoneId -and $ExistingMeta.zoneId) { $ZoneId = [string]$ExistingMeta.zoneId }

function Get-OAuthToken {
  $wrangler = $WranglerPath
  if (!$wrangler) {
    $command = Get-Command wrangler.cmd -ErrorAction SilentlyContinue
    if (!$command) { $command = Get-Command wrangler -ErrorAction SilentlyContinue }
    if ($command) { $wrangler = $command.Source }
  }
  if ($wrangler) { try { & $wrangler whoami *> $null } catch { } }
  $p = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
  if (!(Test-Path -LiteralPath $p)) { throw '未找到 Wrangler OAuth 配置，请先运行 wrangler whoami。' }
  $text = Get-Content -LiteralPath $p -Raw
  $m = [regex]::Match($text, 'oauth_token\s*=\s*"([^"]+)"')
  if (!$m.Success) { throw '未找到有效 Wrangler OAuth，请先运行 wrangler whoami。' }
  return $m.Groups[1].Value
}
function Invoke-Cf {
  param([string]$Method,[string]$Uri,[string]$Token,[object]$Body)
  $headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
  try {
    $params = @{ Method=$Method; Uri=$Uri; Headers=$headers; ErrorAction='Stop' }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
    $result = Invoke-RestMethod @params
    if ($result.success -eq $false) { throw ('Cloudflare 请求未成功：' + (($result.errors | ForEach-Object {$_.message}) -join '; ')) }
    return $result
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    $detail = $_.ErrorDetails.Message
    if ($detail) { try { $parsed = $detail | ConvertFrom-Json; $msg = @($parsed.errors | ForEach-Object { "code=$($_.code) message=$($_.message)" }) -join '; ' } catch { $msg = $detail } } else { $msg = $_.Exception.Message }
    throw "Cloudflare HTTP $status：$msg"
  }
}
function Save-TunnelToken([string]$Value) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Add-Type -AssemblyName System.Security
  $plain = [Text.Encoding]::UTF8.GetBytes($Value)
  try { $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes((Join-Path $DataDir 'tunnel-token.dpapi'), $cipher) } finally { [Array]::Clear($plain, 0, $plain.Length); if ($cipher) { [Array]::Clear($cipher, 0, $cipher.Length) } }
}
function Deploy([string]$DnsToken,[Action[string]]$Report) {
  $oauth = $null
  try {
    if (!$Hostname -or $Hostname -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' -or $Hostname.Contains('..')) { throw '请输入有效的公网主机名。' }
    if (!$ZoneId -or $ZoneId -notmatch '^[A-Za-z0-9]{16,64}$') { throw '请输入有效的 Cloudflare Zone ID。' }
    if (!$TunnelName -or $TunnelName.Length -gt 64 -or $TunnelName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw '请输入有效的 Tunnel 名称。' }
    $Report.Invoke('正在读取固定域名当前 DNS 状态…')
    $oauth = Get-OAuthToken
    $zone = Invoke-Cf GET "https://api.cloudflare.com/client/v4/zones/$ZoneId" $oauth $null
    if (!$zone.success) { throw 'Zone 读取失败。' }
    $dns = Invoke-Cf GET "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records?name=$Hostname&per_page=100" $DnsToken $null
    $existingRecord = @($dns.result)
    $accountId = $zone.result.account.id
    if (!$accountId) { throw '未能从 zone 读取所属 accountId。' }
    $Report.Invoke("已确认 zone 与账号：$accountId；正在查找独立 Tunnel…")
    $list = Invoke-Cf GET "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel?per_page=100" $oauth $null
    $tunnel = $null
    if ($ExistingMeta) {
      $tunnel = @($list.result | Where-Object { $_.id -eq $ExistingMeta.tunnelId -and $_.name -eq $TunnelName }) | Select-Object -First 1
    }
    if (-not $tunnel -and $existingRecord.Count -gt 0) {
      if ($existingRecord.Count -ne 1 -or $existingRecord[0].type -ne 'CNAME' -or $existingRecord[0].content -notmatch '^([0-9a-f-]+)\.cfargotunnel\.com$') { throw "已存在 $Hostname DNS 记录且不是本工具可恢复的 Tunnel CNAME，已停止。" }
      $candidateId = $Matches[1]; $tunnel = @($list.result | Where-Object { $_.id -eq $candidateId -and $_.name -eq $TunnelName }) | Select-Object -First 1
      if (!$tunnel) { throw '已有 DNS CNAME 的 Tunnel 不属于本工具，已停止，不覆盖现有配置。' }
    }
    if (-not $tunnel -and @($list.result | Where-Object name -eq $TunnelName).Count -gt 0) {throw '已存在同名通道但不属于本工具的保存配置，已停止，避免修改其他通道。'}
    if (!$tunnel) { $tunnel = (Invoke-Cf POST "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel" $oauth @{ name=$TunnelName; config_src='cloudflare' }).result }
    if (!$tunnel.id) { throw 'Tunnel 创建或复用失败。' }
    $config = @{ config = @{ ingress = @(@{ hostname=$Hostname; service='http://127.0.0.1:3939' }, @{ service='http_status:404' }) } }
    $configuration = Invoke-Cf GET "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel/$($tunnel.id)/configurations" $oauth $null
    $ingress = @($configuration.result.config.ingress)
    $validRecovery = ($ingress.Count -eq 2 -and $ingress[0].hostname -eq $Hostname -and $ingress[0].service -eq 'http://127.0.0.1:3939' -and $ingress[1].service -eq 'http_status:404')
    if (!$validRecovery) { Invoke-Cf PUT "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel/$($tunnel.id)/configurations" $oauth $config | Out-Null }
    $record = if ($existingRecord.Count -eq 1) { [pscustomobject]@{ result = $existingRecord[0] } } else { Invoke-Cf POST "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records" $DnsToken @{ type='CNAME'; name=$Hostname; content="$($tunnel.id).cfargotunnel.com"; ttl=1; proxied=$true } }
    $tunnelToken = (Invoke-Cf GET "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel/$($tunnel.id)/token" $oauth $null).result
    if (!$tunnelToken) { throw 'Tunnel token 获取失败。' }
    Save-TunnelToken $tunnelToken
    $meta = @{ publicUrl="https://$Hostname"; tunnelId=$tunnel.id; accountId=$accountId; zoneId=$ZoneId; dnsRecordId=$record.result.id } | ConvertTo-Json -Compress
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    [IO.File]::WriteAllText((Join-Path $DataDir 'cloudflare.json'), $meta, [Text.UTF8Encoding]::new($false))
    $Report.Invoke("配置完成：$Hostname；正在验证 HTTPS…")
    try { $check = Invoke-WebRequest -Uri "https://$Hostname/api/info" -UseBasicParsing -TimeoutSec 15; $Report.Invoke("HTTPS 验证返回 HTTP $($check.StatusCode)。") } catch { $Report.Invoke('DNS/Tunnel 配置已完成；当前服务尚未响应 HTTPS，请先启动邻传。') }
    return "完成：$Hostname`nTunnel ID: $($tunnel.id)`n配置已保存到 data/cloudflare.json，Tunnel token 已以当前 Windows 用户 DPAPI 保存。"
  } finally { $oauth = $null; $tunnelToken = $null; $DnsToken = $null; [GC]::Collect(); [GC]::WaitForPendingFinalizers() }
}

if ($NonInteractive) { throw '必须通过安全窗口输入 DNS API Token。' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form; $form.Text='邻传固定域名配置'; $form.Size=New-Object Drawing.Size(700,560); $form.StartPosition='CenterScreen'; $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false
$label=New-Object Windows.Forms.Label; $label.Text="配置 Cloudflare Tunnel 的独立子域名。只会读取或新增该主机名记录，不修改主站。DNS Token 仅在本窗口内存中使用，不会写入文件。"; $label.Location=New-Object Drawing.Point(20,20); $label.Size=New-Object Drawing.Size(650,48); $form.Controls.Add($label)
$hostLabel=New-Object Windows.Forms.Label; $hostLabel.Text='公网主机名'; $hostLabel.Location=New-Object Drawing.Point(20,82); $hostLabel.Size=New-Object Drawing.Size(120,24); $form.Controls.Add($hostLabel)
$hostBox=New-Object Windows.Forms.TextBox; $hostBox.Location=New-Object Drawing.Point(150,80); $hostBox.Size=New-Object Drawing.Size(500,28); $hostBox.Text=$Hostname; $form.Controls.Add($hostBox)
$zoneLabel=New-Object Windows.Forms.Label; $zoneLabel.Text='Cloudflare Zone ID'; $zoneLabel.Location=New-Object Drawing.Point(20,122); $zoneLabel.Size=New-Object Drawing.Size(120,24); $form.Controls.Add($zoneLabel)
$zoneBox=New-Object Windows.Forms.TextBox; $zoneBox.Location=New-Object Drawing.Point(150,120); $zoneBox.Size=New-Object Drawing.Size(500,28); $zoneBox.Text=$ZoneId; $form.Controls.Add($zoneBox)
$tunnelLabel=New-Object Windows.Forms.Label; $tunnelLabel.Text='Tunnel 名称'; $tunnelLabel.Location=New-Object Drawing.Point(20,162); $tunnelLabel.Size=New-Object Drawing.Size(120,24); $form.Controls.Add($tunnelLabel)
$tunnelBox=New-Object Windows.Forms.TextBox; $tunnelBox.Location=New-Object Drawing.Point(150,160); $tunnelBox.Size=New-Object Drawing.Size(500,28); $tunnelBox.Text=$TunnelName; $form.Controls.Add($tunnelBox)
$wranglerLabel=New-Object Windows.Forms.Label; $wranglerLabel.Text='Wrangler 路径（可空）'; $wranglerLabel.Location=New-Object Drawing.Point(20,202); $wranglerLabel.Size=New-Object Drawing.Size(120,24); $form.Controls.Add($wranglerLabel)
$wranglerBox=New-Object Windows.Forms.TextBox; $wranglerBox.Location=New-Object Drawing.Point(150,200); $wranglerBox.Size=New-Object Drawing.Size(500,28); $wranglerBox.Text=$WranglerPath; $form.Controls.Add($wranglerBox)
$tokenLabel=New-Object Windows.Forms.Label; $tokenLabel.Text='DNS 编辑 Token'; $tokenLabel.Location=New-Object Drawing.Point(20,242); $tokenLabel.Size=New-Object Drawing.Size(120,24); $form.Controls.Add($tokenLabel)
$box=New-Object Windows.Forms.TextBox; $box.Location=New-Object Drawing.Point(150,240); $box.Size=New-Object Drawing.Size(500,28); $box.UseSystemPasswordChar=$true; $form.Controls.Add($box)
$status=New-Object Windows.Forms.Label; $status.Location=New-Object Drawing.Point(20,285); $status.Size=New-Object Drawing.Size(650,90); $form.Controls.Add($status)
$button=New-Object Windows.Forms.Button; $button.Text='安全配置'; $button.Location=New-Object Drawing.Point(20,400); $button.Size=New-Object Drawing.Size(110,34); $form.Controls.Add($button)
$close=New-Object Windows.Forms.Button; $close.Text='关闭'; $close.Location=New-Object Drawing.Point(145,400); $close.Size=New-Object Drawing.Size(90,34); $form.Controls.Add($close)
$close.Add_Click({ $box.Clear(); $form.Close() }); $button.Add_Click({ if (!$box.Text) { $status.Text='请输入 DNS API Token。'; return }; $script:Hostname=$hostBox.Text.Trim(); $script:ZoneId=$zoneBox.Text.Trim(); $script:TunnelName=$tunnelBox.Text.Trim(); $script:WranglerPath=$wranglerBox.Text.Trim(); $button.Enabled=$false; try { $status.Text='处理中，请勿关闭窗口…'; $result=Deploy $box.Text ([Action[string]]{ param($s) $status.Text=$s; $form.Refresh() }); $box.Clear(); [Windows.Forms.MessageBox]::Show($result,'邻传配置完成') | Out-Null; $form.Close() } catch { $box.Clear(); $status.Text=$_.Exception.Message; [Windows.Forms.MessageBox]::Show($status.Text,'配置未完成',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Error) | Out-Null; $button.Enabled=$true } finally { $box.Clear() } });
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.Add_Shown({
  $form.Activate()
  $form.BringToFront()
  [IO.File]::WriteAllText((Join-Path $DataDir 'setup-window-state.json'), (@{pid=$PID;visible=$form.Visible;title=$form.Text}|ConvertTo-Json), [Text.UTF8Encoding]::new($false))
})
[void]$form.ShowDialog()
$box.Clear(); $hostBox.Clear(); $zoneBox.Clear(); $tunnelBox.Clear(); $wranglerBox.Clear()
Remove-Item -LiteralPath (Join-Path $DataDir 'setup-window-state.json') -ErrorAction SilentlyContinue
