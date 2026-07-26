<#
.SYNOPSIS
  Ставит или снимает автозапуск моста при входе в систему.

.DESCRIPTION
  Без автозапуска «работа из любой точки» ломается на первой перезагрузке: машина
  включилась, мост не поднялся, и об этом никто не узнает — сообщения будут копиться
  в очереди Telegram молча.

  Задача регистрируется только для текущего пользователя, без прав администратора
  и без SYSTEM: мосту нужен доступ к профилю (токен, ключи, кеш моделей), а из-под
  SYSTEM его бы не было.

  Ничего не делает молча: без -Install или -Remove просто показывает текущее состояние.

.EXAMPLE
  .\autostart.ps1              # показать состояние
  .\autostart.ps1 -Install     # включить автозапуск при входе
  .\autostart.ps1 -Remove      # выключить
#>
[CmdletBinding()]
param([switch]$Install, [switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'Claude Code Telegram Bridge'
$Starter = Join-Path $PSScriptRoot 'bridge-start.ps1'

function Show-State {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Write-Host "[+] Автозапуск включён." -ForegroundColor Green
    Write-Host "    состояние задачи: $($t.State)" -ForegroundColor DarkGray
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($info) { Write-Host "    последний запуск: $($info.LastRunTime) (код $($info.LastTaskResult))" -ForegroundColor DarkGray }
  } else {
    Write-Host "[-] Автозапуск выключен." -ForegroundColor DarkGray
    Write-Host "    включить: .\autostart.ps1 -Install" -ForegroundColor DarkGray
  }
}

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[+] Автозапуск снят." -ForegroundColor Green
  } else {
    Write-Host "[=] Задачи и не было." -ForegroundColor DarkGray
  }
  exit 0
}

if (-not $Install) { Show-State; exit 0 }

if (-not (Test-Path $Starter)) { Write-Host "[!] нет $Starter" -ForegroundColor Red; exit 1 }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Starter`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Задержка, чтобы сеть и scoop-шимы успели подняться: без неё мост стартует раньше
# сети и уходит в цикл переподключения.
$trigger.Delay = 'PT45S'
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description 'Поднимает мост Telegram -> Claude Code при входе в систему.' | Out-Null

Write-Host ''
Write-Host "[+] Автозапуск включён." -ForegroundColor Green
Write-Host "    мост поднимется через 45 с после входа в систему" -ForegroundColor DarkGray
Write-Host "    при падении перезапустится до 3 раз с интервалом в минуту" -ForegroundColor DarkGray
Write-Host "    снять: .\autostart.ps1 -Remove" -ForegroundColor DarkGray
Write-Host ''
Write-Host "    Учти: это вход в систему, а не включение компьютера." -ForegroundColor Yellow
Write-Host "    Если машина уходит в сон, мост умирает вместе с ней." -ForegroundColor Yellow
