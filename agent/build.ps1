param([string]$Version = "")
# Builds dist/exponential-agent.exe (Windows GUI subsystem, no console window). Needs Go 1.27 (winget install GoLang.Go).
# Also: generates assets/exponential.ico when missing (tools/mkicon) and embeds icon + version info (go-winres).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
# Default version = the one in main.go (single source).
if (-not $Version) {
  $m = [regex]::Match((Get-Content (Join-Path $PSScriptRoot 'main.go') -Raw), 'var version = "([^"]+)"')
  if (-not $m.Success) { throw "cannot read the version from main.go" }
  $Version = $m.Groups[1].Value
}
$winresVersion = 'v0.3.3'
$files = Join-Path $PSScriptRoot 'internal/plugin/files'
$src = (Resolve-Path (Join-Path $PSScriptRoot '../plugin')).Path
if (Test-Path $files) { Remove-Item -Recurse -Force $files }
New-Item -ItemType Directory -Force $files | Out-Null
Copy-Item -Recurse -Force (Join-Path $src '*') $files
New-Item -ItemType File -Force (Join-Path $files ".gitkeep") | Out-Null
# The embedded copy must equal plugin/ (a stale copy once shipped an old worklog script).
$rel = { param($root) Get-ChildItem -Recurse -File $root | Where-Object { $_.Name -ne '.gitkeep' } | ForEach-Object { '{0} {1}' -f $_.FullName.Substring($root.Length), (Get-FileHash $_.FullName -Algorithm SHA256).Hash } | Sort-Object }
$diff = Compare-Object (& $rel $src) (& $rel (Resolve-Path $files).Path)
if ($diff) { throw "internal/plugin/files differs from plugin/ after the copy" }
$env:CGO_ENABLED = '0'

if (-not (Test-Path assets/exponential.ico)) {
  go run ./tools/mkicon assets/exponential.ico
  if ($LASTEXITCODE -ne 0) { throw "mkicon failed" }
}

# Version resource: x.y.z -> x.y.z.0 (numeric parts only)
$nums = @(($Version -split '[^0-9]+' | Where-Object { $_ -ne '' }) + @('0','0','0','0'))[0..3]
$v4 = $nums -join '.'
(Get-Content winres/winres.template.json -Raw).Replace('@VERSION4@', $v4).Replace('@VERSION@', $Version) |
  ForEach-Object { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'winres/winres.json'), $_, (New-Object System.Text.UTF8Encoding($false))) }
$ErrorActionPreference = 'Continue' # go prints download progress on stderr
go run "github.com/tc-hib/go-winres@$winresVersion" make --in winres/winres.json --arch amd64
if ($LASTEXITCODE -ne 0) { throw "go-winres failed" }
$ErrorActionPreference = 'Stop'

go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=$Version" -o dist/exponential-agent.exe .
if ($LASTEXITCODE -ne 0) { throw "go build failed" }
Write-Host ("built dist/exponential-agent.exe {0:N1} MB" -f ((Get-Item dist/exponential-agent.exe).Length / 1MB))

