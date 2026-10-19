# Run-wide state holder. Imported (not re-imported with -Force) from each container's BeforeAll.
$script:State = $null
$script:LoadId = [guid]::NewGuid().ToString('N').Substring(0, 8)   # changes if the module is re-loaded

function Get-RunState {
    if ($null -eq $script:State) {
        $script:State = [pscustomobject]@{
            CreatedAt = Get-Date
            Id        = [guid]::NewGuid().ToString('N').Substring(0, 8)
            Hits      = [System.Collections.Generic.List[string]]::new()
        }
        Write-Host "MARKER: RunState created id=$($script:State.Id) (module load $script:LoadId)"
    }
    $script:State
}
function Clear-RunState { $script:State = $null }
Export-ModuleMember -Function Get-RunState, Clear-RunState
