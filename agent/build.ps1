param([string]$Version = "0.4.1")
# Builds dist/exponential-agent.exe (Windows GUI subsystem, no console window). Needs Go 1.27 (winget install GoLang.Go).
# Also: generates assets/exponential.ico when missing (tools/mkicon) and embeds icon + version info (go-winres).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$winresVersion = 'v0.3.3'
$files = Join-Path $PSScriptRoot 'internal/plugin/files'
if (Test-Path $files) { Remove-Item -Recurse -Force $files }
New-Item -ItemType Directory -Force $files | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot '../plugin/*') $files
New-Item -ItemType File -Force (Join-Path $files ".gitkeep") | Out-Null
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

