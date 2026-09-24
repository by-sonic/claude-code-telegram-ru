<#
.SYNOPSIS
  Что сейчас запущено и всё ли готово к работе.
#>
[CmdletBinding()]
param()

$Root = $PSScriptRoot
$cfgPath = Join-Path $Root 'workspaces.json'
# Явный UTF-8: без BOM Get-Content в PS 5.1 прочитал бы кириллицу как ANSI.
function Read-Utf8Json($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return $null }
}
$cfg = Read-Utf8Json $cfgPath
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue

# Мост держит лог открытым, поэтому читаем с разделяемым доступом и явным UTF-8.
function Show-LogTail($path, $count = 4) {
  if (-not (Test-Path $path)) { return }
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try { $txt = (New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Dispose() }
  ($txt -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last $count) | ForEach-Object {
    Write-Host "        $_" -ForegroundColor DarkGray
  }
}

# ~ и %ПЕРЕМЕННЫЕ% в путях — так же, как их раскрывает сам мост.
function Expand-BridgePath($p) {
  $p = [Environment]::ExpandEnvironmentVariables([string]$p)
  if ($p -eq '~' -or $p -match '^~[\\/]') { $p = Join-Path $env:USERPROFILE $p.Substring(1).TrimStart('\', '/') }
  return $p
}

# Включён ли официальный плагин telegram (см. одноимённую функцию в bridge-start.ps1).
function Test-TelegramPluginEnabled {
  $ErrorActionPreference = 'Continue'
  $id = 'telegram@claude-plugins-official'
  $raw = (& claude plugin list --json 2>$null | Out-String).Trim()
  if ($raw.StartsWith('[')) {
    try {
      foreach ($p in ($raw | ConvertFrom-Json)) { if ($p.id -eq $id -and $p.enabled) { return $true } }
      return $false
    } catch {}
  }
  $text = & claude plugin list 2>$null | Out-String
  $i = $text.IndexOf($id)
  if ($i -lt 0) { return $false }
  $tail = $text.Substring($i + $id.Length)
  $next = $tail.IndexOf('@')
  if ($next -ge 0) { $tail = $tail.Substring(0, $next) }
  return $tail -match '\benabled\b'
}

Write-Host ''
Write-Host '  ОКРУЖЕНИЕ' -ForegroundColor Cyan
foreach ($t in @('claude', 'bun', 'uv', 'ffmpeg')) {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  $mark = if ($c) { '+' } else { '!' }
  $color = if ($c) { 'Green' } else { 'Red' }
  Write-Host ("    [{0}] {1}" -f $mark, $t) -ForegroundColor $color
}

# Модель whisper кешируется в HF-кеш. Пока её нет, первая голосовая будет качать ~1.6 ГБ.
$hf = Join-Path $env:USERPROFILE '.cache\huggingface\hub'
$whisperCached = (Test-Path $hf) -and @(Get-ChildItem $hf -Directory -Filter '*whisper*' -ErrorAction SilentlyContinue).Count -gt 0
Write-Host ("    [{0}] модель whisper {1}" -f
  $(if ($whisperCached) { '+' } else { '!' }),
  $(if ($whisperCached) { 'в кеше' } else { 'не скачана (первая голосовая будет долгой)' })
) -ForegroundColor $(if ($whisperCached) { 'Green' } else { 'Yellow' })

Write-Host ''
Write-Host '  МОСТ' -ForegroundColor Cyan
$bridge = @($all | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bridge.ts*' })
$logPath = Join-Path $Root 'bridge\bridge.log'
if ($bridge.Count) {
  Write-Host ("    [+] РАБОТАЕТ (pid {0})" -f ($bridge.ProcessId -join ', ')) -ForegroundColor Green
  Show-LogTail $logPath
} else {
  Write-Host '    [!] не запущен — .\bridge-start.ps1' -ForegroundColor Yellow
  # Хвост лога и ошибок подскажет, почему мост лёг.
  if (Test-Path $logPath) {
    Write-Host '    последние строки лога:' -ForegroundColor DarkGray
    Show-LogTail $logPath
    Show-LogTail "$logPath.err"
  }
}

Write-Host ''
Write-Host '  НАСТРОЙКИ' -ForegroundColor Cyan
$stateDir = Join-Path $env:USERPROFILE '.claude\channels\telegram'
$hasToken = Test-Path (Join-Path $stateDir '.env')
$hasAccess = Test-Path (Join-Path $stateDir 'access.json')
Write-Host ("    [{0}] токен бота" -f $(if ($hasToken) { '+' } else { '!' })) -ForegroundColor $(if ($hasToken) { 'Green' } else { 'Red' })
Write-Host ("    [{0}] access.json (кому можно писать)" -f $(if ($hasAccess) { '+' } else { '!' })) -ForegroundColor $(if ($hasAccess) { 'Green' } else { 'Red' })

if (-not $cfg) {
  Write-Host '    [!] workspaces.json не читается — мост возьмёт настройки по умолчанию' -ForegroundColor Red
} else {
  # Как и мост: слот office, а если его нет — первый.
  $slotProp = $null
  if ($cfg.slots) {
    $slotProp = $cfg.slots.PSObject.Properties['office']
    if (-not $slotProp) { $slotProp = @($cfg.slots.PSObject.Properties)[0] }
  }
  $slot = if ($slotProp) { $slotProp.Value } else { $null }
  $dir = Expand-BridgePath $(if ($slot -and $slot.dir) { $slot.dir } else { '~\Desktop' })
  Write-Host ("    папка:  {0}" -f $dir) -ForegroundColor DarkGray
  if (-not (Test-Path $dir)) { Write-Host '    [!] рабочая папка не существует — мост будет работать в домашней. Поправь dir в workspaces.json' -ForegroundColor Red }
  $addDirs = @($slot.addDirs | Where-Object { $_ } | ForEach-Object { Expand-BridgePath $_ })
  $addOk = @($addDirs | Where-Object { Test-Path $_ }).Count
  Write-Host ("    доступных папок проектов: {0} из {1}" -f $addOk, $addDirs.Count) -ForegroundColor DarkGray

  # Модель и effort могли сменить из чата (/model, /effort) — показываем действующие.
  $settings = (Read-Utf8Json (Join-Path $Root 'bridge\state.json')).settings
  $model = if ($settings.model) { "$($settings.model) (выбрана в чате)" } else { $cfg.defaults.model }
  $effort = if ($settings.effort) { "$($settings.effort) (выбран в чате)" } else { $cfg.defaults.effort }
  Write-Host ("    модель: {0} / effort {1} / права {2}" -f $model, $effort, $cfg.defaults.permissionMode) -ForegroundColor DarkGray
}

# Официальный плагин канала опрашивает тот же токен и отберёт getUpdates у моста.
if ((Get-Command claude -ErrorAction SilentlyContinue) -and (Test-TelegramPluginEnabled)) {
  Write-Host ''
  Write-Host '  [!] Плагин telegram ВКЛЮЧЁН — он будет драться с мостом за токен (409 Conflict).' -ForegroundColor Red
  Write-Host '      claude plugin disable telegram' -ForegroundColor DarkGray
}
Write-Host ''
