<#
.SYNOPSIS
  Убивает процессы задачи по уникальному маркеру в командной строке.

.DESCRIPTION
  Вызывается мостом при отмене задачи из чата.

  Почему не taskkill /T: к моменту отмены claude.exe уже развернул рабочие
  процессы, и когда промежуточный родитель исчезает, они переподвешиваются к
  другому родителю и выпадают из дерева. Обход по ParentProcessId их тоже не
  находит. Поэтому корни ищем по маркеру — им служит id сессии, он уникален для
  задачи и присутствует в аргументах (--session-id / --resume).

.PARAMETER Marker
  Строка для поиска в CommandLine. Обычно UUID сессии.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Marker)

$ErrorActionPreference = 'SilentlyContinue'

if ($Marker.Length -lt 8) { Write-Output 'marker too short'; exit 1 }

$snapshot = @(Get-CimInstance Win32_Process)
$roots = @($snapshot | Where-Object { $_.CommandLine -like "*$Marker*" })
if (-not $roots.Count) { Write-Output 'killed 0'; exit 0 }

# Потомки корней маркер не несут (шелл, сборка, сабагенты), поэтому их добираем
# обходом дерева от каждого найденного корня.
$targets = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Generic.Queue[int]]::new()
foreach ($r in $roots) {
  [void]$targets.Add([int]$r.ProcessId)
  $queue.Enqueue([int]$r.ProcessId)
}
while ($queue.Count) {
  $current = $queue.Dequeue()
  foreach ($child in $snapshot | Where-Object { $_.ParentProcessId -eq $current }) {
    if ($targets.Add([int]$child.ProcessId)) { $queue.Enqueue([int]$child.ProcessId) }
  }
}

# Себя и своих предков не трогаем — иначе скрипт снесёт вызвавший его мост.
$protected = [System.Collections.Generic.HashSet[int]]::new()
$cursor = $PID
while ($cursor -gt 0) {
  [void]$protected.Add($cursor)
  $parent = ($snapshot | Where-Object { $_.ProcessId -eq $cursor } | Select-Object -First 1).ParentProcessId
  if (-not $parent -or $parent -eq $cursor) { break }
  $cursor = [int]$parent
}

$count = 0
foreach ($t in $targets) {
  if ($protected.Contains($t)) { continue }
  Stop-Process -Id $t -Force
  $count++
}
Write-Output "killed $count"
