# Agent w tle: co chwilę pyta tracker, czy czeka na ten komputer praca, i ją uruchamia.
#  - analiza zlecona z telefonu (albo z cudzego komputera, gdy projekt ma kolejkę zespołu): odpala tracker-handler.ps1,
#    który sam przejmuje zlecenie (claim) i zapisuje analizę;
#  - "Start on my PC": otwiera VS Code z Claude Code i poleceniem zadania.
# Startuje przy logowaniu z HKCU Run (install.ps1), jeden na użytkownika (mutex).
#
# Bezpieczeństwo: serwer nazywa tylko zlecenia (rodzaj + klucz zgłoszenia albo numer zlecenia). Co faktycznie
# się uruchamia, ustalamy TUTAJ i w tracker-handler.ps1; adres z serwera nigdy nie jest uruchamiany wprost.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'tracker-agent'
$log = Join-Path $dir 'log.txt'
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) agent: $m" -Encoding utf8 }

$mtx = New-Object Threading.Mutex($false, 'Local\tracker-agent')
if (-not $mtx.WaitOne(0)) { exit 0 }

Add-Type -AssemblyName System.Web.Extensions
$json = New-Object Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue
$handler = Join-Path $dir 'tracker-handler.ps1'
$child = $null
$delay = 2
$errLogged = $false
# Ostatni błąd pętli: idzie do trackera przy najbliższym udanym zapytaniu (Ustawienia pokazują go przy komputerze).
$lastErr = ''
$keyRe = '^[A-Z]{2,10}-\d{1,6}$'

# Konto i token jak w tracker-handler.ps1 (ta sama tożsamość co MCP w Claude Code).
function Read-Token {
  $accounts = @(Get-ChildItem (Join-Path $env:USERPROFILE '.claude-accounts') -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName) + @($env:USERPROFILE)
  $activeFile = Join-Path $dir 'active-account.txt'
  # Pusty plik (hook z konta domyślnego) = ''. ReadAllText, bo Get-Content -Raw na pustym pliku nie zwraca nic.
  $account = if (Test-Path $activeFile) { [IO.File]::ReadAllText($activeFile).Trim() } else { $null }
  if ($null -eq $account -or ($account -and -not (Test-Path (Join-Path $account '.claude.json')))) {
    $account = $accounts | Where-Object { Test-Path (Join-Path $_ '.claude.json') } |
      Sort-Object { (Get-Item (Join-Path $_ '.claude.json')).LastWriteTime } | Select-Object -Last 1
  }
  $mcp = $null
  foreach ($d in (@($account) + $accounts | Where-Object { $_ })) {
    $f = Join-Path $d '.claude.json'
    if ((-not $mcp) -and (Test-Path $f)) { $mcp = $json.DeserializeObject((Get-Content $f -Raw -Encoding utf8)).mcpServers.tracker }
  }
  return $mcp
}

Log "start (PID $PID)"
while ($true) {
  try {
    # Konfiguracja i token co obieg: ponowna instalacja działa bez restartu agenta.
    $cfg = Get-Content (Join-Path $dir 'config.json') -Raw -Encoding utf8 | ConvertFrom-Json
    if (-not $cfg.deviceId) { throw 'Brak deviceId w config.json (uruchom instalacje ponownie)' }
    $mcp = Read-Token
    if (-not $mcp) { throw 'Brak serwera MCP "tracker" w zadnym koncie Claude Code' }
    $base = $mcp.url -replace '/mcp/?$', ''
    $headers = @{ Authorization = $mcp.headers.Authorization }

    # Zajęty: nasz potomek żyje albo trwa przebieg uruchomiony z przeglądarki (tracker://), co widać po pliku .lock.
    $busy = ($child -and -not $child.HasExited) -or [bool](Get-ChildItem $dir -Filter '*.lock' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) })
    $repos = ($cfg.repos.PSObject.Properties.Name) -join ','
    $errQ = if ($lastErr) { '&error=' + [uri]::EscapeDataString($lastErr.Substring(0, [Math]::Min($lastErr.Length, 300))) } else { '' }
    $res = Invoke-RestMethod -Uri "$base/api/agent/work?deviceId=$($cfg.deviceId)&name=$([uri]::EscapeDataString($env:COMPUTERNAME))&busy=$([int][bool]$busy)&repos=$repos&version=$($cfg.version)$errQ" -Headers $headers -TimeoutSec 60
    # Serwer odebrał błąd, więc lokalnie go czyścimy.
    $lastErr = ''
    $delay = 2
    $errLogged = $false

    # Jedno zlecenie naraz; serwer przy zajętym agencie i tak nic nie zwraca.
    $job = if (-not $busy) { @($res.jobs) | Select-Object -First 1 } else { $null }
    if ($job -and $job.kind -eq 'analyze') {
      if ($job.key -notmatch $keyRe) { throw "odrzucony klucz z serwera: $($job.key)" }
      $url = "tracker://analyze/$($job.key)" + $(if ($job.deep) { '?deep' } else { '' })
      Log "analiza $($job.key)"
      # Handler sam przejmuje zlecenie; przy 409 (ktoś był pierwszy) kończy po cichu.
      $child = Start-Process powershell.exe -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$handler`"", "`"$url`"", '-Background' -WindowStyle Hidden -PassThru
    } elseif ($job -and $job.kind -eq 'start') {
      try {
        $claimBody = @{ deviceId = $cfg.deviceId } | ConvertTo-Json
        $claim = Invoke-RestMethod -Method Post -Uri "$base/api/agent/start-jobs/$([int]$job.id)/claim" -Headers $headers -ContentType 'application/json' -Body $claimBody
        $key = [string]$claim.key
        if ($key -notmatch $keyRe) { throw "odrzucony klucz z serwera: $key" }
        # Link jak openInClaude w aplikacji; Windows obcina dłuższe, więc wersja skrócona, a na końcu samo odwołanie.
        $max = 1900
        $mk = { param($p) 'vscode://anthropic.claude-code/open?prompt=' + [uri]::EscapeDataString($p) }
        $link = & $mk (Invoke-RestMethod -Uri "$base/api/issues/$key/prompt/start" -Headers $headers).prompt
        if ($link.Length -gt $max) { $link = & $mk (Invoke-RestMethod -Uri "$base/api/issues/$key/prompt/start?compact=1" -Headers $headers).prompt }
        if ($link.Length -gt $max) { $link = & $mk "Pracujemy nad $key. Pełne dane: get_issue $key." }
        Log "start pracy $key"
        # Brak obsługi vscode:// rzuca wyjątek; zgłaszamy go do Ustawień zamiast milczeć.
        try { Start-Process $link } catch { $lastErr = "$(Get-Date -Format 'HH:mm') Nie udalo sie otworzyc VS Code: $($_.Exception.Message)"; Log $lastErr }
      } catch {
        # 409 = ktoś był pierwszy albo zlecenie wygasło: nic do zrobienia.
        if (-not ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409)) { throw }
      }
    }
    # Bez przerwy po udanej odpowiedzi: serwer sam wstrzymuje żądanie (long poll). Chroni tylko przed pętlą bez opóźnienia.
    if (-not $busy -and -not $job) { Start-Sleep -Milliseconds 200 }
  } catch {
    $lastErr = "$(Get-Date -Format 'HH:mm') $($_.Exception.Message)"
    if (-not $errLogged) { Log "blad: $($_.Exception.Message)"; $errLogged = $true }
    Start-Sleep $delay
    $delay = [Math]::Min($delay * 2, 60)
  }
}
