# Obsługa linków tracker://analyze/ACME-16[?deep] z guzika Analyze w trackerze.
# Odpala Claude Code bez okna w repo i zapisuje analizę w zgłoszeniu przez MCP trackera.
#
# Bezpieczeństwo: link może podsunąć dowolna strona, więc z linku bierzemy tylko akcję i numer
# zgłoszenia. Treść polecenia przychodzi z trackera (szablon projektu, zalogowany tokenem), a to,
# co agentowi wolno, jest ustalone TUTAJ (--allowedTools) i szablon tego nie zmieni.
param([string]$Url)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'tracker-agent'
$log = Join-Path $dir 'log.txt'
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" -Encoding utf8 }

try {
  if ($Url -notmatch '^tracker://analyze/([A-Za-z]{2,10}-\d{1,6})/?(\?deep)?$') { Log "odrzucony link: $Url"; exit 1 }
  $key = $Matches[1].ToUpper()
  $deep = [bool]$Matches[2]
  $model = if ($deep) { 'opus' } else { 'sonnet' }   # gdy serwer nie poda modelu projektu

  $cfg = Get-Content (Join-Path $dir 'config.json') -Raw -Encoding utf8 | ConvertFrom-Json

  # Jedna analiza danego zgłoszenia naraz (podwójne kliknięcie, dwa okna).
  $lock = Join-Path $dir "$key.lock"
  if ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-30))) { Log "$key juz trwa, pomijam"; exit 0 }
  Set-Content -Path $lock -Value $PID

  # Token i adres z konfiguracji MCP trackera w Claude Code: ta sama tożsamość, zero osobnej konfiguracji.
  # Nie ConvertFrom-Json: w PS 5.1 klucze różniące się wielkością liter (projekty 'e:/x' i 'E:/x') to dla niego duplikaty.
  Add-Type -AssemblyName System.Web.Extensions
  $json = New-Object Web.Script.Serialization.JavaScriptSerializer
  $json.MaxJsonLength = [int]::MaxValue
  # Konto Claude Code (CLAUDE_CONFIG_DIR): link tracker:// startuje bez tej zmiennej. Bierzemy konto, na którym
  # deweloper ostatnio pracował (zapisuje je hook pluginu przy każdym poleceniu), bo przy kilku kontach przełącza
  # się między nimi, gdy jedno wyczerpie limit. Bez tego pliku: konto z najświeżej zmienionym .claude.json.
  $accounts = @(Get-ChildItem (Join-Path $env:USERPROFILE '.claude-accounts') -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName) + @($env:USERPROFILE)
  $activeFile = Join-Path $dir 'active-account.txt'
  # Pusty plik (hook z konta domyślnego) = ''. ReadAllText, bo Get-Content -Raw na pustym pliku nie zwraca nic i .Trim() się wywraca.
  $account = if (Test-Path $activeFile) { [IO.File]::ReadAllText($activeFile).Trim() } else { $null }
  if ($null -eq $account -or ($account -and -not (Test-Path (Join-Path $account '.claude.json')))) {
    $account = $accounts | Where-Object { Test-Path (Join-Path $_ '.claude.json') } |
      Sort-Object { (Get-Item (Join-Path $_ '.claude.json')).LastWriteTime } | Select-Object -Last 1
  }
  if ($account -and $account -ne $env:USERPROFILE) { $env:CLAUDE_CONFIG_DIR = $account } else { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
  # Token trackera: z konta, na którym idziemy, a gdy go tam nie ma, z dowolnego konta (to ta sama osoba).
  $mcp = $null
  foreach ($d in (@($account) + $accounts | Where-Object { $_ })) {
    $f = Join-Path $d '.claude.json'
    if ((-not $mcp) -and (Test-Path $f)) { $mcp = $json.DeserializeObject((Get-Content $f -Raw -Encoding utf8)).mcpServers.tracker }
  }
  if (-not $mcp) { throw 'Brak serwera MCP "tracker" w zadnym koncie Claude Code (claude mcp add ...)' }
  Log "konto: $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { 'domyslne' })"
  $base = $mcp.url -replace '/mcp/?$', ''
  $headers = @{ Authorization = $mcp.headers.Authorization }

  $deepQuery = if ($deep) { '?deep=1' } else { '' }
  $res = Invoke-RestMethod -Uri "$base/api/issues/$key/prompt/analyze$deepQuery" -Headers $headers
  $prompt = $res.prompt
  # Model ustawia projekt (Settings > Prompts); serwer go sprawdza, ale idzie do argumentu programu, więc sprawdzamy też tu.
  if ($res.model -in 'haiku', 'sonnet', 'opus', 'fable') { $model = $res.model }
  Log "start $key ($model)"

  # Tylko MCP trackera, bez reszty serwerów użytkownika: szybszy start i mniej narzędzi w kontekście.
  $mcpFile = Join-Path $dir 'mcp.json'
  $mcpJson = @{ mcpServers = @{ tracker = $mcp } } | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($mcpFile, $mcpJson, (New-Object Text.UTF8Encoding $false))

  $ext = Get-ChildItem (Join-Path $env:USERPROFILE '.vscode/extensions') -Directory -Filter 'anthropic.claude-code-*' |
    Sort-Object { [version](($_.Name -replace '^anthropic\.claude-code-([\d.]+).*$', '$1')) } | Select-Object -Last 1
  if (-not $ext) { throw 'Nie znaleziono rozszerzenia Claude Code w VS Code' }
  $claude = Join-Path $ext.FullName 'resources/native-binary/claude.exe'

  # Opis zgłoszenia pisze każdy członek projektu, więc traktujemy go jak niezaufany (prompt injection).
  # Read/Grep/Glob celowo NIE są na liście: bez jawnej zgody działają tylko w katalogu repo, a odczyt
  # poza nim (~/.claude.json z tokenem, ~/.ssh) w trybie -p dostaje odmowę. Sprawdzone 2026-10-20.
  # --setting-sources project: bez uprawnień z ustawień użytkownika, które bywają szerokie.
  $allowed = 'Skill,mcp__tracker__get_issue,mcp__tracker__list_comments,mcp__tracker__list_issues,mcp__tracker__set_analysis'
  $denied = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch'
  $env:TRACKER_HOOKS = '0'   # sesja w tle nie zostawia worklogu w zgłoszeniu
  # Repo projektu z klucza zgłoszenia (WEB-3 -> WEB); stara instalacja miała jedno repoDir.
  $projectKey = $key -replace '-\d+$', ''
  $repoDir = if ($cfg.repos) { $cfg.repos.$projectKey } else { $cfg.repoDir }
  if (-not $repoDir -or -not (Test-Path $repoDir)) {
    # Nowy projekt (albo przeniesiony klon): szukamy klonu jak instalator, a gdy go nie ma, pytamy oknem wyboru folderu.
    $full = (@(Invoke-RestMethod -Uri "$base/api/projects" -Headers $headers) | Where-Object { $_.key -eq $projectKey }).githubRepo
    if (-not $full) { throw "Projekt $projectKey nie ma ustawionego repo GitHub (Settings > projekt > GitHub repo)" }
    $cc = if ($account) { Join-Path $account '.claude.json' } else { $null }
    $candidates = @()
    if ($cc -and (Test-Path $cc)) {
      $ccProjects = $json.DeserializeObject((Get-Content $cc -Raw -Encoding utf8)).projects
      if ($ccProjects) { $candidates += $ccProjects.Keys | Where-Object { Test-Path $_ } | ForEach-Object { $_; Split-Path $_ -Parent; (Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue).FullName } }
    }
    $candidates += 'Desktop', 'Documents', 'source', 'repos', 'projects', 'Projekty', 'code', 'dev', 'git', 'work' |
      ForEach-Object { Join-Path $env:USERPROFILE $_ } | Where-Object { Test-Path $_ } |
      ForEach-Object { Get-ChildItem $_ -Directory -Recurse -Depth 3 -Force -Filter '.git' -ErrorAction SilentlyContinue | ForEach-Object { $_.Parent.FullName } }
    $isClone = { param($d) $d -and ((Get-Content (Join-Path $d '.git/config') -Raw -ErrorAction SilentlyContinue) -match "[/:]$([regex]::Escape($full))(\.git)?\s") }
    $repoDir = $candidates | Where-Object { & $isClone $_ } | Select-Object -First 1
    if (-not $repoDir) {
      Add-Type -AssemblyName System.Windows.Forms
      $owner = New-Object Windows.Forms.Form -Property @{ TopMost = $true }
      $pick = New-Object Windows.Forms.FolderBrowserDialog -Property @{ Description = "Tracker: wskaz klon repo $full (projekt $projectKey)" }
      $repoDir = if ($pick.ShowDialog($owner) -eq 'OK') { $pick.SelectedPath } else { $null }
      $owner.Dispose()
      if (-not $repoDir) { throw "Brak repo projektu $projectKey na tym komputerze (anulowano wybor folderu)" }
      if (-not (& $isClone $repoDir)) { throw "$repoDir nie jest klonem $full" }
    }
    $repos = @{}
    if ($cfg.repos) { $cfg.repos.PSObject.Properties | ForEach-Object { $repos[$_.Name] = $_.Value } }
    $repos[$projectKey] = $repoDir
    [IO.File]::WriteAllText((Join-Path $dir 'config.json'), (@{ repos = $repos } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Log "repo $projectKey -> $repoDir"
  }
  Set-Location $repoDir
  # Polecenie przez stdin w UTF-8: PowerShell 5.1 psuje cudzysłowy w argumentach programów.
  $OutputEncoding = New-Object Text.UTF8Encoding $false
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false   # odczyt odpowiedzi Claude'a (UTF-8), nie strona kodowa konsoli
  # PowerShell 5.1 przy 'Stop' zamienia każdą linię stderr programu (zwykłe ostrzeżenia) w błąd krytyczny.
  $ErrorActionPreference = 'Continue'
  # Skille z pluginu trackera (zawsze aktualne z serwera), niezależnie od tego, co jest w repo i u użytkownika.
  $prompt | & $claude -p --model $model --plugin-url "$base/agent/plugin.zip" --allowedTools $allowed --disallowedTools $denied --setting-sources project --strict-mcp-config --mcp-config $mcpFile 2>&1 |
    ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8   # *>> w PS 5.1 pisze UTF-16
  Log "koniec $key (kod $LASTEXITCODE)"
} catch {
  Log "blad: $($_.Exception.Message)"
} finally {
  if ($lock) { Remove-Item $lock -ErrorAction SilentlyContinue }
  # Bez samoaktualizacji: kod z serwera nie nadpisuje skryptu po cichu. Aktualizacja = ponowne install.ps1.
  try {
    $cmdKey = 'HKCU:\Software\Classes\tracker\shell\open\command'
    $cmd = (Get-ItemProperty $cmdKey).'(default)'
    if ($cmd -notmatch '^conhost') { Set-ItemProperty $cmdKey '(default)' "conhost.exe --headless $cmd" }
  } catch { Log "aktualizacja: $($_.Exception.Message)" }
}
