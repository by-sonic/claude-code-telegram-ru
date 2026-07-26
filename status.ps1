<#
.SYNOPSIS
  Что сейчас запущено и всё ли готово к работе.
#>
[CmdletBinding()]
param()

$Root = $PSScriptRoot
$cfgPath = Join-Path $Root 'workspaces.json'
# Явный UTF-8: без BOM Get-Content в PS 5.1 прочитал бы кириллицу как ANSI.
$cfg = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue

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
if ($bridge.Count) {
  Write-Host ("    [+] РАБОТАЕТ (pid {0})" -f ($bridge.ProcessId -join ', ')) -ForegroundColor Green
  # Мост держит лог открытым, поэтому читаем с разделяемым доступом и явным UTF-8.
  $logPath = Join-Path $Root 'bridge\bridge.log'
  if (Test-Path $logPath) {
    $fs = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try { $txt = (New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Dispose() }
    ($txt -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 4) | ForEach-Object {
      Write-Host "        $_" -ForegroundColor DarkGray
    }
  }
} else {
  Write-Host '    [!] не запущен — .\bridge-start.ps1' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  НАСТРОЙКИ' -ForegroundColor Cyan
$stateDir = Join-Path $env:USERPROFILE '.claude\channels\telegram'
$hasToken = Test-Path (Join-Path $stateDir '.env')
$hasAccess = Test-Path (Join-Path $stateDir 'access.json')
Write-Host ("    [{0}] токен бота" -f $(if ($hasToken) { '+' } else { '!' })) -ForegroundColor $(if ($hasToken) { 'Green' } else { 'Red' })
Write-Host ("    [{0}] access.json (кому можно писать)" -f $(if ($hasAccess) { '+' } else { '!' })) -ForegroundColor $(if ($hasAccess) { 'Green' } else { 'Red' })

$slot = $cfg.slots.office
Write-Host ("    папка:  {0}" -f $slot.dir) -ForegroundColor DarkGray
$dirOk = Test-Path $slot.dir
if (-not $dirOk) { Write-Host '    [!] рабочая папка не существует — поправь dir в workspaces.json' -ForegroundColor Red }
$addOk = @($slot.addDirs | Where-Object { Test-Path $_ }).Count
Write-Host ("    доступных папок проектов: {0} из {1}" -f $addOk, @($slot.addDirs).Count) -ForegroundColor DarkGray
Write-Host ("    модель: {0} / effort {1} / права {2}" -f $cfg.defaults.model, $cfg.defaults.effort, $cfg.defaults.permissionMode) -ForegroundColor DarkGray

# Официальный плагин канала опрашивает тот же токен и отберёт getUpdates у моста.
$tgPlugin = claude plugin list 2>&1 | Out-String
if ($tgPlugin -match 'telegram@claude-plugins-official[\s\S]{0,120}?enabled') {
  Write-Host ''
  Write-Host '  [!] Плагин telegram ВКЛЮЧЁН — он будет драться с мостом за токен (409 Conflict).' -ForegroundColor Red
  Write-Host '      claude plugin disable telegram' -ForegroundColor DarkGray
}
Write-Host ''
