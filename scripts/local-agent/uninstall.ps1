# Usuwa lokalną analizę (odwrotność install.ps1):  irm __TRACKER_URL__/agent/uninstall.ps1 | iex
$base = '__TRACKER_URL__'
# deviceId czytamy PRZED usunięciem folderu: tracker ma zapomnieć ten komputer.
$deviceId = $null
try { $deviceId = (Get-Content (Join-Path $env:LOCALAPPDATA 'tracker-agent/config.json') -Raw -Encoding utf8 | ConvertFrom-Json).deviceId } catch { }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*tracker-agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'TrackerAgent' -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Classes\tracker' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA 'tracker-agent') -Recurse -Force -ErrorAction SilentlyContinue
try {
  # Nie ConvertFrom-Json: w PS 5.1 klucze różniące się wielkością liter to dla niego duplikaty.
  Add-Type -AssemblyName System.Web.Extensions
  $json = New-Object Web.Script.Serialization.JavaScriptSerializer
  $json.MaxJsonLength = [int]::MaxValue
  # Jak w install.ps1: konto z CLAUDE_CONFIG_DIR, konta w ~/.claude-accounts, na końcu ~/.claude.json.
  $dirs = @($env:CLAUDE_CONFIG_DIR) + @(Get-ChildItem (Join-Path $env:USERPROFILE '.claude-accounts') -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName) + @($env:USERPROFILE)
  $mcp = $null
  foreach ($d in ($dirs | Where-Object { $_ })) {
    $f = Join-Path $d '.claude.json'
    if ((-not $mcp) -and (Test-Path $f)) { $mcp = $json.DeserializeObject((Get-Content $f -Raw -Encoding utf8)).mcpServers.tracker }
  }
  $auth = @{ Authorization = $mcp.headers.Authorization }
  if ($deviceId) { Invoke-RestMethod -Method Delete -Uri "$base/api/agents/$deviceId" -Headers $auth | Out-Null }
  Invoke-RestMethod -Method Delete -Uri "$base/api/me/local-agent" -ContentType application/json -Body "{}" -Headers $auth | Out-Null
} catch { Write-Host 'Nie udalo sie powiadomic Exponential; analiza i tak jest usunieta z tego komputera.' }
Write-Host 'Usunieto lokalna analize.'
