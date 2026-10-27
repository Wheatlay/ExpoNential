# Instalacja lokalnej analizy jedną komendą (Settings > Claude Code w trackerze ją pokazuje):
#   $env:TRACKER_TOKEN='trk_...'; irm __TRACKER_URL__/agent/install.ps1 | iex   (pierwszy raz: dodaje też MCP)
#   irm __TRACKER_URL__/agent/install.ps1 | iex                                  (aktualizacja)
# Rejestruje tracker:// dla bieżącego użytkownika Windows (HKCU, bez admina), sam znajduje klony repo
# Twoich projektów i zgłasza trackerowi, że jest zainstalowane (guzik Analyze zaczyna działać od razu).
# Repo, którego nie znajdzie, podajesz ręcznie albo pomijasz. Usunięcie: uninstall.ps1.

$ErrorActionPreference = 'Stop'
$base = '__TRACKER_URL__'
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

# 1. Token trackera z konfiguracji MCP w Claude Code (ten sam, którego używa Claude).
# Przy kilku kontach Claude Code (CLAUDE_CONFIG_DIR, np. ~/.claude-accounts/<konto>) konfiguracja MCP jest w katalogu
# konta. Kolejność: zmienna środowiskowa, konta z serwerem "tracker", na końcu ~/.claude.json. Konta NIE zapamiętujemy:
# analiza w tle bierze to, na którym ostatnio pracowałeś (active-account.txt z hooka pluginu). Plugin instaluje się
# raz dla wszystkich kont (katalog plugins i settings.json są u nich wspólne).
# Nie ConvertFrom-Json: w PS 5.1 klucze różniące się wielkością liter (projekty 'e:/x' i 'E:/x') to dla niego duplikaty.
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue
$configDirs = @($env:CLAUDE_CONFIG_DIR) + @(Get-ChildItem (Join-Path $env:USERPROFILE '.claude-accounts') -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName) + @($env:USERPROFILE)
function Read-Mcp($d) {
  $f = Join-Path $d '.claude.json'
  if (Test-Path $f) { $c = $json.DeserializeObject((Get-Content $f -Raw -Encoding utf8)); if ($c.mcpServers.tracker) { return @{ cfg = $c; mcp = $c.mcpServers.tracker } } }
  return $null
}

# Rozszerzenie Claude Code w VS Code (z niego bierzemy program claude.exe).
$ext = Get-ChildItem (Join-Path $env:USERPROFILE '.vscode/extensions') -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue |
  Sort-Object { [version](($_.Name -replace '^anthropic\.claude-code-([\d.]+).*$', '$1')) } | Select-Object -Last 1
if (-not $ext) { Say 'Brak rozszerzenia Claude Code w VS Code. Zainstaluj je i uruchom instalacje ponownie.' Yellow; return }
$claudeExe = Join-Path $ext.FullName 'resources/native-binary/claude.exe'

# Polecenie z Ustawień niesie świeży token ($env:TRACKER_TOKEN): dodajemy serwer MCP trackera każdemu kontu
# Claude Code, które go jeszcze nie ma, więc całe podłączenie to jedno polecenie. Bez tokenu (aktualizacja)
# korzystamy z tego, co już jest.
$accountDirs = @($configDirs | Where-Object { $_ } | Select-Object -Unique)
if ($env:TRACKER_TOKEN) {
  $prevDir = $env:CLAUDE_CONFIG_DIR
  $ErrorActionPreference = 'Continue'   # claude.exe pisze ostrzeżenia na stderr, PS 5.1 przy 'Stop' robi z nich błąd
  foreach ($d in $accountDirs) {
    if ((Read-Mcp $d) -or -not (Test-Path (Join-Path $d '.claude.json'))) { continue }
    if ($d -eq $env:USERPROFILE) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR = $d }
    & $claudeExe mcp add --transport http --scope user tracker "$base/mcp" --header "Authorization: Bearer $($env:TRACKER_TOKEN)" 2>&1 | Out-Null
    Say "Serwer MCP trackera dodany: $d" Green
  }
  $ErrorActionPreference = 'Stop'
  $env:CLAUDE_CONFIG_DIR = $prevDir
  Remove-Item Env:TRACKER_TOKEN -ErrorAction SilentlyContinue
}
$cfg = $null; $mcp = $null; $configDir = $null
foreach ($d in $accountDirs) { $r = Read-Mcp $d; if ($r) { $cfg = $r.cfg; $mcp = $r.mcp; $configDir = $d; break } }
# Domyślny katalog (~/.claude.json) nie jest kontem z CLAUDE_CONFIG_DIR: wtedy niczego nie wymuszamy.
if ($configDir -eq $env:USERPROFILE) { $configDir = $null }
if (-not $mcp) {
  Say 'Brak polaczenia z trackerem. Skopiuj polecenie instalacji z trackera (Ustawienia > Claude Code > Utworz polecenie) i uruchom je.' Yellow
  return
}

# 3. Repo każdego projektu (pole "GitHub repo" w ustawieniach projektu). Klonów szukamy w folderach
#    otwieranych w Claude Code (bywają na innym dysku), potem w typowych miejscach profilu.
$auth = @{ Authorization = $mcp.headers.Authorization }
$projects = @(Invoke-RestMethod -Uri "$base/api/projects" -Headers $auth | Where-Object { $_.githubRepo })
if (-not $projects) {
  Say 'Zaden Twoj projekt nie ma ustawionego repo GitHub (Settings > projekt > GitHub repo). Popros admina projektu i uruchom instalacje ponownie.' Yellow
  return
}
$candidates = @()
if ($cfg.projects) {
  $candidates += $cfg.projects.Keys | Where-Object { Test-Path $_ } |
    ForEach-Object { $_; Split-Path $_ -Parent; (Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue).FullName } |
    Where-Object { $_ -and (Test-Path (Join-Path $_ '.git')) }
}
$roots = 'Desktop', 'Documents', 'source', 'repos', 'projects', 'Projekty', 'code', 'dev', 'git', 'work' |
  ForEach-Object { Join-Path $env:USERPROFILE $_ } | Where-Object { Test-Path $_ }
$candidates += foreach ($r in $roots) {
  Get-ChildItem $r -Directory -Recurse -Depth 3 -Force -Filter '.git' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | ForEach-Object { $_.Parent.FullName }
}
function Test-Clone($dir, $full) { (Get-Content (Join-Path $dir '.git/config') -Raw -ErrorAction SilentlyContinue) -match "[/:]$([regex]::Escape($full))(\.git)?\s" }
$repos = @{}
foreach ($p in $projects) {
  $repo = $candidates | Where-Object { Test-Clone $_ $p.githubRepo } | Select-Object -First 1
  if (-not $repo) {
    # Okno wyboru folderu; Anuluj pomija projekt (Analyze zapyta o niego ponownie przy pierwszym użyciu).
    Say "Nie znalazlem klonu $($p.githubRepo) (projekt $($p.key)). Wskaz folder albo Anuluj, zeby pominac." Yellow
    try {
      Add-Type -AssemblyName System.Windows.Forms
      $owner = New-Object Windows.Forms.Form -Property @{ TopMost = $true }
      $pick = New-Object Windows.Forms.FolderBrowserDialog -Property @{ Description = "Tracker: wskaz klon repo $($p.githubRepo) (projekt $($p.key))" }
      $repo = if ($pick.ShowDialog($owner) -eq 'OK') { $pick.SelectedPath } else { '' }
      $owner.Dispose()
    } catch { $repo = '' }
    if ($repo -and -not (Test-Path (Join-Path $repo '.git'))) { Say "$repo nie jest repozytorium git, pomijam $($p.key)" Yellow; $repo = '' }
  }
  if ($repo) { $repos[$p.key] = (Resolve-Path $repo).Path }
}
if (-not $repos.Count) { Say 'Nie znalazlem zadnego repo projektow, nic nie instaluje.' Yellow; return }

# 4. Skrypt obsługi i konfiguracja w %LOCALAPPDATA%\tracker-agent.
$dir = Join-Path $env:LOCALAPPDATA 'tracker-agent'
New-Item -ItemType Directory -Force $dir | Out-Null
$handler = Join-Path $dir 'tracker-handler.ps1'
$code = (Invoke-WebRequest "$base/agent/tracker-handler.ps1" -UseBasicParsing).Content
if ($code -is [byte[]]) { $code = [Text.Encoding]::UTF8.GetString($code) }
# BOM, bo PowerShell 5.1 czyta pliki bez niego w stronie kodowej systemu (psuje polskie znaki).
[IO.File]::WriteAllText($handler, $code, (New-Object Text.UTF8Encoding $true))
# Agent w tle (tracker-agent.ps1): podejmuje analizy zlecone z telefonu i "Start on my PC".
$agent = Join-Path $dir 'tracker-agent.ps1'
$agentCode = (Invoke-WebRequest "$base/agent/tracker-agent.ps1" -UseBasicParsing).Content
if ($agentCode -is [byte[]]) { $agentCode = [Text.Encoding]::UTF8.GetString($agentCode) }
# Najpierw zatrzymujemy starego agenta, żeby nie trzymał skryptu w trakcie podmiany.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*tracker-agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
[IO.File]::WriteAllText($agent, $agentCode, (New-Object Text.UTF8Encoding $true))
# Tożsamość tego komputera dla trackera: zachowujemy przy ponownej instalacji.
$deviceId = $null
$cfgFile = Join-Path $dir 'config.json'
if (Test-Path $cfgFile) { try { $deviceId = (Get-Content $cfgFile -Raw -Encoding utf8 | ConvertFrom-Json).deviceId } catch { } }
if (-not $deviceId) { $deviceId = [guid]::NewGuid().ToString() }
[IO.File]::WriteAllText($cfgFile, (@{ repos = $repos; deviceId = $deviceId } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

# 5. Protokół tracker:// tylko dla tego użytkownika. conhost --headless: bez okna (Windows Terminal ignoruje -WindowStyle Hidden).
$root = 'HKCU:\Software\Classes\tracker'
New-Item -Path "$root\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $root -Name '(default)' -Value 'URL:Tracker local agent'
Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$root\shell\open\command" -Name '(default)' `
  -Value "conhost.exe --headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$handler`" `"%1`""

# 5a. Agent w tle startuje przy logowaniu (HKCU Run, bez admina) i od razu teraz.
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'TrackerAgent' `
  -Value "conhost.exe --headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agent`""
Start-Process conhost.exe -ArgumentList '--headless', 'powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$agent`""

# 5b. Plugin "tracker" w Claude Code (skille analizy i zamykania, hook śladu pracy) dla każdego repo i projektu.
#     Ponowne uruchomienie instalacji aktualizuje go do wersji z serwera.
$prevConfigDir = $env:CLAUDE_CONFIG_DIR
if ($configDir) { $env:CLAUDE_CONFIG_DIR = $configDir }
$ErrorActionPreference = 'Continue'   # claude.exe pisze ostrzeżenia na stderr, PS 5.1 przy 'Stop' robi z nich błąd
& $claudeExe plugin marketplace add "$base/agent/marketplace.json" 2>&1 | Out-Null
& $claudeExe plugin marketplace update tracker 2>&1 | Out-Null
& $claudeExe plugin install tracker@tracker 2>&1 | Out-Null
& $claudeExe plugin update tracker@tracker 2>&1 | Out-Null
$pluginOk = (& $claudeExe plugin list 2>&1 | Out-String) -match 'tracker@tracker'
$ErrorActionPreference = 'Stop'
$env:CLAUDE_CONFIG_DIR = $prevConfigDir
if ($pluginOk) { Say 'Plugin Claude Code "tracker" zainstalowany (skille analizy i zamykania, slad pracy).' Green }
else { Say "Nie udalo sie zainstalowac pluginu. Recznie: claude plugin marketplace add $base/agent/marketplace.json; claude plugin install tracker@tracker" Yellow }

# 6. Tracker zapamiętuje, że masz lokalną analizę: Analyze odpala ją od razu.
Invoke-RestMethod -Method Post -Uri "$base/api/me/local-agent" -ContentType application/json -Body "{}" -Headers $auth | Out-Null

Say 'Gotowe. Repo projektow:' Green
foreach ($k in $repos.Keys) { Say "  $k -> $($repos[$k])" Green }
$skipped = $projects | Where-Object { -not $repos.ContainsKey($_.key) }
if ($skipped) { Say "Bez repo na tym komputerze: $(($skipped | ForEach-Object { $_.key }) -join ', '). Analyze w nich sam poszuka klonu albo zapyta o folder." Yellow }
Say 'Nowy projekt albo nowy klon: Analyze sam go znajdzie albo zapyta o folder, bez ponownej instalacji.'
Say 'Analyze w trackerze uruchamia teraz Claude w tle na tym komputerze. Przy pierwszym kliknieciu przegladarka zapyta o otwarcie aplikacji: zaznacz "zawsze".'
Say 'Agent w tle odbiera analizy zlecone z telefonu i "Start on my PC" (rusza przy logowaniu do Windows).'
Say "Log: $dir\log.txt"
