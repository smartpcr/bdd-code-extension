param([string]$Ver='4.3.2')
$here = $PSScriptRoot
Remove-Item "$here\bin\$Ver\Debug\net10.0\q2-log.txt" -ErrorAction SilentlyContinue
& "$here\..\tools\run.ps1" Q2Init $Ver 'NONE' run
"  LOG:"; Get-Content "$here\bin\$Ver\Debug\net10.0\q2-log.txt" | % { "    $_" }
