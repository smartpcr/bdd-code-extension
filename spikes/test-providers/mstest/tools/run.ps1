param([string]$Proj, [string]$Ver='4.3.2', [string]$Variant='', [string]$Tag='run', [string[]]$Extra=@())
$root = Split-Path $PSScriptRoot
$rd = Join-Path $root "results\$Proj-$Ver-$Tag"
Remove-Item -Recurse -Force $rd -ErrorAction SilentlyContinue
$args2 = @("test", (Join-Path $root "$Proj\$Proj.csproj"), "-p:MSTestVer=$Ver", "-p:Variant=$Variant", "--logger", "trx;LogFileName=r.trx", "--results-directory", $rd, "--nologo") + $Extra
Write-Output "### dotnet $($args2 -join ' ')"
$o = & dotnet @args2 2>&1
$code = $LASTEXITCODE
$o | Where-Object { $_ -match 'Passed|Failed|failed|error|Error|Skipped|Total|TEARDOWN|Cleanup|cleanup|Warning|warning|Exception|crash|exit|abort|Results File|^\s+at |Test Run' } | Where-Object { $_ -notmatch '^\s+at (Microsoft|System)\.' } | Select-Object -First 40 | ForEach-Object { "  CONSOLE $_" }
Write-Output "  EXITCODE $code"
$trx = Get-ChildItem $rd -Filter *.trx -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($trx) { & (Join-Path $PSScriptRoot 'trx.ps1') $trx.FullName } else { "  NO TRX" }
