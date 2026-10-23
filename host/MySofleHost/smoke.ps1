# Smoke test: launch dist exe, confirm child zmk-hid-host appears, then stop both.
$p = Start-Process "$PSScriptRoot\dist\MySofleHost.exe" -PassThru
Start-Sleep 6
$tray = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
$host1 = @(Get-Process zmk-hid-host -ErrorAction SilentlyContinue)
"tray running: $($null -ne $tray); host procs: $($host1.Count)"
# Quit path: killing tray leaves child, so stop both explicitly
Stop-Process -Id $p.Id
foreach ($h in $host1) { Stop-Process -Id $h.Id }
"cleaned"
