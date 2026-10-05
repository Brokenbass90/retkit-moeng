# RetKit AI — one-command setup for Windows (no admin rights needed).
#   irm https://raw.githubusercontent.com/Brokenbass90/retkit-moeng/main/install/install-windows.ps1 | iex
# Installs only what is missing:
#   1. Claude Code (official installer)      -> %USERPROFILE%\.local\bin\claude.exe
#   2. Node.js LTS, private copy for RetKit   -> %LOCALAPPDATA%\RetKit\node
#   3. RetKit AI bridge                       -> %LOCALAPPDATA%\RetKit\bridge
#   4. No autostart items are created
#   5. Claude login if needed. Set $env:RETKIT_CODEX = "1" before running to also install Codex.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = if ($env:RETKIT_REPO) { $env:RETKIT_REPO } else { 'Brokenbass90/retkit-moeng' }
$Ref = if ($env:RETKIT_REF) { $env:RETKIT_REF } else { 'main' }
$RK = Join-Path $env:LOCALAPPDATA 'RetKit'
New-Item -ItemType Directory -Force -Path $RK | Out-Null
function Say($t) { Write-Host "`n> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
$env:Path = "$env:USERPROFILE\.local\bin;$RK\node;$env:Path"

Say 'Claude Code'
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok 'already installed' }
else {
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'claude is not on PATH after install - open a new PowerShell window and run this again' }
  Ok 'installed'
}

Say 'Node.js for the RetKit bridge'
$Node = $null
$existing = Get-Command node -ErrorAction SilentlyContinue
if ($existing) {
  $major = [int]((& node -v).TrimStart('v').Split('.')[0])
  if ($major -ge 20) { $Node = $existing.Source; Ok "using $(& node -v)" }
}
if (-not $Node) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { throw "No Node.js download for win-$arch" }
  $sum, $file = ($line -split '\s+')
  $zip = Join-Path $env:TEMP $file
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $sum.ToLower()) { throw 'Node.js checksum mismatch' }
  $tmp = Join-Path $env:TEMP "retkit-node-$(Get-Random)"
  Expand-Archive $zip -DestinationPath $tmp -Force
  if (Test-Path "$RK\node") { Remove-Item "$RK\node" -Recurse -Force }
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName "$RK\node"
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  $Node = "$RK\node\node.exe"
  Ok "installed private Node $(& $Node -v)"
}

if ($env:RETKIT_CODEX -eq '1') {
  Say 'Codex'
  if (Get-Command codex -ErrorAction SilentlyContinue) { Ok 'already installed' }
  else {
    $npm = Join-Path (Split-Path $Node) 'npm.cmd'
    & $npm install -g --prefix "$RK\node" '@openai/codex' | Out-Null
    Ok 'installed (note: on Windows the RetKit bridge currently drives Claude; Codex support is experimental)'
  }
}

Say 'RetKit AI bridge'
$zip = Join-Path $env:TEMP 'retkit.zip'
Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" -OutFile $zip -UseBasicParsing
$tmp = Join-Path $env:TEMP "retkit-src-$(Get-Random)"
Expand-Archive $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Recurse -Directory -Filter bridge | Select-Object -First 1
if (-not $src) { throw 'bridge folder not found in the download' }
if (Test-Path "$RK\bridge") { Remove-Item "$RK\bridge" -Recurse -Force }
Copy-Item $src.FullName "$RK\bridge" -Recurse
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
Ok "installed in $RK\bridge"

Say 'Start the bridge when you need RetKit AI'
# Deliberately no Startup-folder entry: managed work machines treat new
# autostart items as persistence.
Write-Host "  `"$Node`" `"$RK\bridge\src\index.mjs`""

Say 'Claude login'
& claude auth status *> $null
if ($LASTEXITCODE -eq 0) { Ok 'already logged in' }
else {
  Write-Host '  A browser window opens for the Claude login. When it says "Login successful", come back here and type /exit.'
  & claude
}
Write-Host "`nRetKit AI is ready. Go back to MoEngage -> RetKit AI: Claude should show as connected." -ForegroundColor Green
