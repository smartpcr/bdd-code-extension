<#
.SYNOPSIS
    An example extension (E3): what a workspace writes to add to the PowerShell
    runtime without editing it.

.DESCRIPTION
    Built only on BddSuite's exported commands (Register-SuiteAction in its
    action file, New-SuiteDiagnostic in its rule), never on a module behind
    them. It adds one of each part of the extension API:

        action       example.echo   returns its text, prefixed with the region
                                    (actions/Echo.ps1)
        context key  region         ${region} in any expression
        option       region         Invoke-BddSuite -Option @{ region = 'eu' },
                                    or Invoke-BddSuite.ps1 -Option region=eu
        rule         a ceiling      a suite tagged slow keeps every case within
                                    10 seconds: E205 at lint, and the limit a
                                    case runs under

    Use it as:

        Invoke-BddSuite -Path example/suites/echo.yml -SchemaRoot example/schema `
            -Extension example/BddSuite.Example.psm1 -Option @{ region = 'eu' }
#>

$script:SlowCeilingSec = 10

function Test-SlowSuite {
    param($Suite)
    return @($Suite.tags) -contains 'slow'
}

function Get-SuiteExtension {
    return @{
        Name        = 'example'
        ActionPath  = @('actions')
        ContextKeys = @('region')
        Options     = @(@{ Name = 'region'; Description = 'The region ${region} reads, and example.echo prefixes.' })
        Start       = {
            param([hashtable]$Options)
            $region = if ($Options.ContainsKey('region')) { [string]$Options['region'] } else { '' }
            return @{ Context = @{ region = $region }; State = @{ region = $region } }
        }
        Rules       = @{
            # At lint: a case of a slow suite that declares more than the
            # ceiling is E205, at the value, like the core's limits.
            Lint         = {
                param($In)
                if (-not (Test-SlowSuite $In.Model)) { return }
                $index = 0
                foreach ($case in @($In.Model.tests)) {
                    $declared = if ($case -is [System.Collections.IDictionary]) { $case['timeoutSec'] } else { $null }
                    if (($declared -is [int] -or $declared -is [long]) -and $declared -gt $script:SlowCeilingSec) {
                        New-SuiteDiagnostic -Code 'E205' -File $In.File -Position $In.Positions["/tests/$index/timeoutSec"] -At 'value' `
                            -Message "Case $($case.name) declares $declared seconds; a suite tagged slow keeps each case within $($script:SlowCeilingSec)."
                    }
                    $index++
                }
            }
            # At run time: whatever a slow suite's case declares, it runs
            # within the ceiling.
            CaseLimitSec = {
                param($Suite, [int]$DeclaredSec)
                if (Test-SlowSuite $Suite) { return [math]::Min($DeclaredSec, $script:SlowCeilingSec) }
                return $DeclaredSec
            }
        }
    }
}

Export-ModuleMember -Function Get-SuiteExtension
