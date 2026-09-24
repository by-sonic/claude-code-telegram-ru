<#
.SYNOPSIS
  Поднимает мост Telegram → Claude Code. Один экземпляр, лог в bridge\bridge.log.

.DESCRIPTION
  Мост не использует официальную фичу Channels (её держит выключенной политика
  Team-организации). Он сам опрашивает Bot API и запускает Claude headless-вызовами.

  Обязательное условие: официальный плагин telegram должен быть выключен, иначе
  два поллера дерутся за токен и оба получают 409 Conflict.
#>
[CmdletBinding()]
param([switch]$Foreground)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Script = Join-Path $Root 'bridge\bridge.ts'
$Log = Join-Path $Root 'bridge\bridge.log'

function Fail($m) { Write-Host "[!] $m" -ForegroundColor Red; exit 1 }
function Note($m) { Write-Host "    $m" -ForegroundColor DarkGray }

# Включён ли официальный плагин telegram. Сначала --json: текстовый вывод
# многострочный, и прежняя регулярка по нему могла зацепить статус соседнего
# плагина — и мост отказывался стартовать при выключенном telegram.
function Test-TelegramPluginEnabled {
  # Нативная команда может писать в stderr, а при ErrorActionPreference=Stop
  # PowerShell 5.1 превращает такую строку в прерывающую ошибку.
  $ErrorActionPreference = 'Continue'
  $id = 'telegram@claude-plugins-official'
  $raw = (& claude plugin list --json 2>$null | Out-String).Trim()
  if ($raw.StartsWith('[')) {
    try {
      foreach ($p in ($raw | ConvertFrom-Json)) { if ($p.id -eq $id -and $p.enabled) { return $true } }
      return $false
    } catch {}
  }
  # Старые версии без --json: смотрим только кусок от id плагина до следующего плагина.
  $text = & claude plugin list 2>$null | Out-String
  $i = $text.IndexOf($id)
  if ($i -lt 0) { return $false }
  $tail = $text.Substring($i + $id.Length)
  $next = $tail.IndexOf('@')
  if ($next -ge 0) { $tail = $tail.Substring(0, $next) }
  return $tail -match '\benabled\b'
}

# Мост держит лог открытым на запись, поэтому обычное чтение падает с IOException.
# Плюс лог в UTF-8: Get-Content в PS 5.1 прочитал бы его как ANSI и выдал кракозябры.
function Read-Log($path) {
  if (-not (Test-Path $path)) { return '' }
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try { return (New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)).ReadToEnd() }
  finally { $fs.Dispose() }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Fail 'нет bun: scoop install bun' }
if (-not (Test-Path $Script)) { Fail "нет файла моста: $Script" }

$envFile = Join-Path $env:USERPROFILE '.claude\channels\telegram\.env'
if (-not (Test-Path $envFile)) { Fail "нет токена: $envFile" }

# Плагин канала обязан быть выключен — иначе борьба за getUpdates.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host '[!] claude не найден в PATH — проверку плагина пропускаю.' -ForegroundColor Yellow
  Note 'Если мост не найдёт claude.exe сам, укажи путь в переменной окружения CLAUDE_EXE.'
} elseif (Test-TelegramPluginEnabled) {
  Write-Host '[!] Плагин telegram включён — он будет драться с мостом за токен.' -ForegroundColor Yellow
  Note 'Выключи: claude plugin disable telegram'
  exit 1
}

$running = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bridge.ts*'
})
if ($running.Count) {
  Write-Host "[=] Мост уже запущен (pid $($running[0].ProcessId))." -ForegroundColor DarkGray
  Note "Лог: $Log"
  exit 0
}

# Хвосты прошлого запуска, если мост упал или его убили: осиротевшие claude-воркеры,
# whisper и поллер плагина. Поллер-сирота держит getUpdates-слот токена, и новый
# мост ловил бы 409 Conflict.
& (Join-Path $Root 'stop.ps1') -Quiet

if ($Foreground) {
  & bun $Script
  exit $LASTEXITCODE
}

# Прошлый лог не удаляем, а откладываем в .prev: если мост упал ночью, а утром его
# перезапустили, причина падения иначе пропала бы вместе с файлом.
foreach ($f in @($Log, "$Log.err")) {
  if (Test-Path $f) { Move-Item $f "$f.prev" -Force -ErrorAction SilentlyContinue }
}

# -WindowStyle Hidden, а НЕ -NoNewWindow: при -NoNewWindow мост делит консоль с этим
# скриптом и умирает вместе с ней, когда окно ярлыка закрывается через несколько секунд.
# Скрытая консоль отвязывает его от родителя, и мост живёт до stop.ps1.
# Путь в кавычках явно: Start-Process не квотирует элементы -ArgumentList, и при
# пробеле в пути (C:\Users\Ivan Petrov\...) bun получил бы обрубок.
$p = Start-Process -FilePath 'bun' -ArgumentList "`"$Script`"" -WorkingDirectory (Join-Path $Root 'bridge') `
     -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 6
if ($null -eq (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
  Write-Host '[!] Мост упал сразу после запуска.' -ForegroundColor Red
  Read-Log "$Log.err"
  Read-Log $Log
  exit 1
}

Write-Host ''
Write-Host "[+] Мост поднят (pid $($p.Id))." -ForegroundColor Green
(Read-Log $Log) -split "`r?`n" | ForEach-Object { if ($_.Trim()) { Note $_.Trim() } }
Write-Host ''
Note 'Пиши боту в Telegram. Погасить всё: .\stop.ps1'
Note "Лог: $Log (прошлый запуск — $Log.prev)"
