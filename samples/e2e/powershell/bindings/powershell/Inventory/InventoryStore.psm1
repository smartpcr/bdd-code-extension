<#
.SYNOPSIS
    The system under test: a store of stock levels by SKU, kept in one JSON
    file. Every action reads it, changes it and writes it back, so the state
    lives in the file and not in a runspace: a case's steps see one store, and
    two cases never share one.
#>

function Get-InventoryFolder {
    return Join-Path ([IO.Path]::GetTempPath()) 'bdd-inventory'
}

function New-InventoryStore([string]$Name) {
    $folder = Get-InventoryFolder
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $path = Join-Path $folder "$Name-$([guid]::NewGuid().ToString('N')).json"
    Set-Content -LiteralPath $path -Value '{}' -NoNewline
    return $path
}

function Read-InventoryStore([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "no store at $Path`: open one with store.open first" }
    $levels = [ordered]@{}
    $read = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    foreach ($sku in $read.Keys) { $levels[$sku] = [long]$read[$sku] }
    return $levels
}

function Write-InventoryStore([string]$Path, [System.Collections.IDictionary]$Levels) {
    Set-Content -LiteralPath $Path -Value (ConvertTo-InventoryJson $Levels) -NoNewline
}

function ConvertTo-InventoryJson([System.Collections.IDictionary]$Levels) {
    return ConvertTo-Json -InputObject $Levels -Compress
}

function Remove-InventoryStore([string]$Path) {
    $existed = Test-Path -LiteralPath $Path
    Remove-Item -LiteralPath $Path, "$Path.sync.json" -Force -ErrorAction SilentlyContinue
    return $existed
}

# The step keys every action requires, checked as the C# binding checks them.
function Get-RequiredText([hashtable]$Step, [string]$Action, [string]$Key) {
    $value = [string]$Step[$Key]
    if (-not $value) { throw "$Action`: $Key is required" }
    return $value
}

function Get-Quantity([hashtable]$Step, [string]$Action) {
    $qty = 0L
    if (-not [long]::TryParse([string]$Step['qty'], [ref]$qty) -or $qty -le 0) {
        throw "$Action`: qty must be a whole number above zero, not '$($Step['qty'])'"
    }
    return $qty
}

Export-ModuleMember -Function *
