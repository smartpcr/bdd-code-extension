<#
.SYNOPSIS
    The greeter's suiterun: the BddSuite module's command line with the
    greeter's extension. The module is found by name on PSModulePath, at the
    release this sample is proved against (docs/packages, E6).
#>
#Requires -Modules @{ ModuleName = 'BddSuite'; RequiredVersion = '0.7.12' }
$ErrorActionPreference = 'Stop'
Import-Module BddSuite -DisableNameChecking
exit (Invoke-BddSuiteCli -Arguments $args -Extension @(Join-Path $PSScriptRoot 'Greeter/Greeter.psm1'))
