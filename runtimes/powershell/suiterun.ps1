<#
.SYNOPSIS
    The entry that moved into the module folder, BddSuite/suiterun.ps1, so an
    installed BddSuite module carries it (docs/packages, D10). This file keeps
    the old path working; it passes every argument on and leaves the exit code
    the entry leaves.
#>
& (Join-Path $PSScriptRoot 'BddSuite/suiterun.ps1') @args
exit $LASTEXITCODE
