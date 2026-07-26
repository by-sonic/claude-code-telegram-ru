<#
.SYNOPSIS
  Гасит мост и всё, что он породил. Ни одного процесса не должно остаться.

.DESCRIPTION
  Уровней несколько: мост (bun bridge.ts) → claude → его собственные потомки,
  плюс процессы whisper. Убить только верхний недостаточно — потомки осиротеют и
  продолжат работать, а осиротевший поллер вообще держит getUpdates-слот токена,
  из-за чего следующий запуск ловит 409 Conflict.

  Дерево обходим сами через ParentProcessId, а не через taskkill /T: так скрипт
  работает и там, где taskkill заблокирован политиками или хуками.
#>
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$killed = [System.Collections.Generic.List[string]]::new()
$snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)

function Say($msg, $color = 'Gray') { if (-not $Quiet) { Write-Host $msg -ForegroundColor $color } }

function Get-Descendants($rootPid) {
  $result = @()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue([int]$rootPid)
  while ($queue.Count) {
    $current = $queue.Dequeue()
    foreach ($child in $snapshot | Where-Object { $_.ParentProcessId -eq $current }) {
      $result += $child
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
  return $result
}

# Своя цепочка родителей: если скрипт запущен ИЗ сессии Claude Code, она попадает
# под шаблоны ниже, и мы бы срубили сук, на котором сидим.
$protected = [System.Collections.Generic.HashSet[int]]::new()
$cursor = $PID
while ($cursor -gt 0) {
  [void]$protected.Add($cursor)
  $parent = ($snapshot | Where-Object { $_.ProcessId -eq $cursor } | Select-Object -First 1).ParentProcessId
  if (-not $parent -or $parent -eq $cursor) { break }
  $cursor = [int]$parent
}

function Stop-Tree($proc, $what) {
  if ($protected.Contains([int]$proc.ProcessId)) { return }
  # Детей глушим первыми: иначе claude успевает осиротеть и продолжает работу.
  foreach ($d in (Get-Descendants $proc.ProcessId)) {
    if ($protected.Contains([int]$d.ProcessId)) { continue }
    Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  $script:killed.Add("$what (pid $($proc.ProcessId))")
}

# 1. Мост.
foreach ($p in $snapshot | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bridge.ts*' }) {
  Stop-Tree $p 'мост Telegram'
}

# 2. Осиротевшие поллеры официального плагина канала. Если он когда-то был включён,
#    его поллер мог остаться и держать getUpdates-слот токена.
foreach ($p in $snapshot | Where-Object {
    $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*server.ts*' -and $_.CommandLine -like '*telegram*'
  }) {
  Stop-Tree $p 'осиротевший поллер плагина'
}

# 5. Claude-воркеры, порождённые мостом. Если мост убили раньше, они осиротели и
#    тянут никому уже не нужную задачу.
#    Признак — bridge-prompt.md, его подставляет только мост. Раньше здесь стоял
#    '--output-format stream-json', и это была опасная ошибка: десктопное приложение
#    Claude запускает claude-code с тем же флагом, так что OFF убивал рабочую сессию.
#    Имя процесса проверяем тоже: иначе под шаблон попадёт что угодно, где эта строка
#    просто упомянута в аргументах — например редактор, открывший этот файл.
foreach ($p in $snapshot | Where-Object {
    $_.Name -match '^(node|claude|cmd)\.exe$' -and $_.CommandLine -like '*bridge-prompt.md*'
  }) {
  Stop-Tree $p 'claude-воркер моста'
}

# 6. Расшифровка голосовых: uv/python могут остаться после убийства воркера.
#    Фильтр по имени процесса обязателен — иначе под шаблон попадает любая оболочка,
#    у которой строка voice2text просто упомянута в командной строке.
foreach ($p in $snapshot | Where-Object {
    $_.Name -match '^(uv|uvx|python|pythonw)\.exe$' -and $_.CommandLine -like '*voice2text*'
  }) {
  Stop-Tree $p 'whisper (voice2text)'
}

# 7. pid-файлы: без уборки новый старт попытается послать SIGTERM в мёртвый pid.
$channelsRoot = Join-Path $env:USERPROFILE '.claude\channels'
$pidFiles = @()
if (Test-Path $channelsRoot) {
  $pidFiles = @(Get-ChildItem $channelsRoot -Filter 'bot.pid' -Recurse -File -ErrorAction SilentlyContinue)
  foreach ($f in $pidFiles) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }
}

if ($killed.Count -eq 0) {
  Say '[=] Ничего не было запущено — уже свободно.' 'DarkGray'
} else {
  Say ''
  Say '[+] Погашено:' 'Green'
  foreach ($k in $killed) { Say "      $k" }
}
if ($pidFiles.Count) { Say "    очищено pid-файлов: $($pidFiles.Count)" 'DarkGray' }
Say ''
