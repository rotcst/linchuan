param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encrypted = [IO.File]::ReadAllBytes($Path)
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($decrypted)) }
finally { [Array]::Clear($decrypted, 0, $decrypted.Length) }
