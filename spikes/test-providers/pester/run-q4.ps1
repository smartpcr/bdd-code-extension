Import-Module Pester -MinimumVersion 5.0
$root = $PSScriptRoot
$file = "$root\q1\orders.Tests.ps1"

function Show($label, [scriptblock]$configure) {
    $c = New-PesterConfiguration
    $c.Run.Path = $file
    $c.Run.PassThru = $true
    $c.Output.Verbosity = 'None'
    & $configure $c
    $r = Invoke-Pester -Configuration $c
    $ran = @($r.Tests | Where-Object Executed | ForEach-Object ExpandedName)
    "{0,-60} filter={1}`n    ran({2}): {3}" -f $label, ($c.Filter.FullName.Value -join ' | '), $ran.Count, ($ran -join ' ; ')
}

$full = 'Orders suite [v=1].rejects a bad quantity [qty=0]'
Show 'raw full name (unescaped)'          { param($c) $c.Filter.FullName = $full }
Show 'WildcardPattern::Escape(full name)' { param($c) $c.Filter.FullName = [WildcardPattern]::Escape($full) }
Show 'Escape(literal ForEach row name)'   { param($c) $c.Filter.FullName = [WildcardPattern]::Escape('Orders suite [v=1].rejects [qty=0]') }
Show 'Escape(template path .<name>)'      { param($c) $c.Filter.FullName = [WildcardPattern]::Escape('Orders suite [v=1].<name>') }
Show 'Escape(row with * ? backtick)'      { param($c) $c.Filter.FullName = [WildcardPattern]::Escape('Orders suite [v=1].name with * and ? and `backtick') }
Show 'two escaped names (array)'          { param($c) $c.Filter.FullName = @([WildcardPattern]::Escape($full), [WildcardPattern]::Escape('Orders suite [v=1].accepts a good order [qty=1]')) }
Show 'Escape(describe) + .*'              { param($c) $c.Filter.FullName = [WildcardPattern]::Escape('Orders suite [v=1]') + '.*' }

"--- -FullNameFilter parameter (legacy simple interface)"
$r = Invoke-Pester -Path $file -FullNameFilter ([WildcardPattern]::Escape($full)) -PassThru -Output None
"ran: " + (($r.Tests | Where-Object Executed | ForEach-Object ExpandedName) -join ' ; ')
$r = Invoke-Pester -Path $file -FullNameFilter $full -PassThru -Output None
"ran (unescaped): " + (($r.Tests | Where-Object Executed | ForEach-Object ExpandedName) -join ' ; ')

"--- Filter.Line (file:line) as alternative"
Show 'Filter.Line orders.Tests.ps1:9' { param($c) $c.Filter.Line = "${file}:9" }
