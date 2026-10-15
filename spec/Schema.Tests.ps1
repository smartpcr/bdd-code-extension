<# .SYNOPSIS The core schema says what an editor needs, and a workspace extends it by import only. #>
<#
.DESCRIPTION
    An editor underlines a misspelled key because the schema declares the keys
    that are legal and closes the object against everything else. That is a
    property of a file, so it is asserted here, for the core schema generated
    from core.catalog.yaml.

    A workspace extends the core by import (DEC-S10): its catalog imports
    other catalogs and suite-schema extensions. The rules that keep the core
    the same for everyone are asserted on generated workspaces: imports
    resolve depth first, a name declared twice or an import cycle is refused,
    and an extension may add fields but never redefine one.

    Run: Invoke-Pester spec/Schema.Tests.ps1
#>

BeforeAll {
    $script:SpecRoot = $PSScriptRoot
    $script:Generator = Join-Path $script:SpecRoot 'Build-Schema.ps1'
    $script:Schema = Get-Content (Join-Path $script:SpecRoot 'suite.schema.json') -Raw | ConvertFrom-Json
    $script:Defs = $script:Schema.'$defs'

    function Get-Definition {
        param($Defs, [string]$Name)
        $found = $Defs.PSObject.Properties | Where-Object Name -eq $Name
        if (-not $found) { throw "The generated schema declares no definition called $Name." }
        return $found.Value
    }

    function Test-Declares {
        param($Definition, [string]$Key)
        return [bool]($Definition.properties.PSObject.Properties | Where-Object Name -eq $Key)
    }

    # A throwaway workspace: files written into a fresh folder, the generator run
    # on its catalog, and either the generated schema or the generator's error.
    function Invoke-Workspace {
        param([hashtable]$Files, [string]$Catalog = 'actions.catalog.yaml')
        $root = Join-Path ([IO.Path]::GetTempPath()) ("bdd-spec-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root | Out-Null
        foreach ($name in $Files.Keys) {
            $path = Join-Path $root $name
            New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
            [IO.File]::WriteAllText($path, ($Files[$name] -replace '\{spec\}', ($script:SpecRoot -replace '\\', '/')))
        }
        # The exception message itself, not PowerShell's formatted (and wrapped) error record.
        $command = "try { & '$($script:Generator)' -Catalog '$(Join-Path $root $Catalog)' } catch { Write-Output `$_.Exception.Message; exit 1 }"
        $output = & pwsh -NoProfile -Command $command 2>&1 | Out-String
        $schemaPath = Join-Path (Split-Path -Parent (Join-Path $root $Catalog)) 'suite.schema.json'
        $result = @{
            ExitCode = $LASTEXITCODE
            Output   = $output
            Schema   = if (Test-Path $schemaPath) { Get-Content $schemaPath -Raw | ConvertFrom-Json } else { $null }
        }
        Remove-Item -LiteralPath $root -Recurse -Force
        return $result
    }

    $script:Action = @'
  - name: {0}
    summary: An action of this workspace.
    bindings: [go]
    interruptible: true
    params:
      - {{ name: target, type: string, required: true }}
    captures: {{ type: any }}
'@
}

Describe 'The core schema an editor reads' {
    It 'closes a case against a key nothing declares, which is what underlines <Wrong>' -ForEach @(
        @{ Definition = 'case'; Right = 'asserts'; Wrong = 'assert' }
        @{ Definition = 'case'; Right = 'timeoutSec'; Wrong = 'timeout' }
        @{ Definition = 'stepCommon'; Right = 'captureAs'; Wrong = 'capture' }
    ) {
        $definition = Get-Definition $script:Defs $Definition
        Test-Declares $definition $Right | Should -BeTrue -Because "$Definition declares $Right"
        Test-Declares $definition $Wrong | Should -BeFalse -Because "$Wrong is the mistake, not the key"
    }

    It 'closes <Definition> so an unknown key has something to be refused by' -ForEach @(
        @{ Definition = 'case' }
        @{ Definition = 'step.core.noop' }
        @{ Definition = 'step.core.set' }
        @{ Definition = 'step.wait' }
        @{ Definition = 'metaStep' }
        @{ Definition = 'assert' }
    ) {
        # E101 and E105 both come from here.
        (Get-Definition $script:Defs $Definition).additionalProperties | Should -BeFalse
    }

    It 'gives <Action> exactly the parameters the catalog declares for it' -ForEach @(
        @{ Action = 'core.set'; Declares = 'value'; Refuses = 'values' }
        @{ Action = 'wait'; Declares = 'forStep'; Refuses = 'forSteps' }
        @{ Action = 'core.noop'; Declares = 'captureAs'; Refuses = 'capturedAs' }
    ) {
        $definition = Get-Definition $script:Defs "step.$Action"
        Test-Declares $definition $Declares | Should -BeTrue
        Test-Declares $definition $Refuses | Should -BeFalse
    }

    It 'holds exactly the core actions' {
        @($script:Defs.step.properties.action.enum) | Should -Be @('core.noop', 'core.set', 'core.fail', 'core.sleep', 'core.record', 'wait')
    }

    It 'carries no product field: <Field> belongs in a workspace extension' -ForEach @(
        @{ Field = 'requires' }, @{ Field = 'sharedChecks' }, @{ Field = 'cluster' }, @{ Field = 'target' }
    ) {
        foreach ($definition in @($script:Schema, $script:Defs.defaults, $script:Defs.case, $script:Defs.stepCommon, $script:Defs.stepEnvelope, $script:Defs.'step.meta')) {
            Test-Declares $definition $Field | Should -BeFalse
        }
        $script:Defs.PSObject.Properties.Name | Should -Not -Contain $Field
    }

    It 'is a draft every JSON Schema validator the runtimes use understands' {
        $script:Schema.'$schema' | Should -Be 'https://json-schema.org/draft/2020-12/schema'
    }

    It 'matches a fresh generation (-Check)' {
        & pwsh -NoProfile -File $script:Generator -Check | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'accepts a binding name of a workspace own in the catalog schema' {
        $catalogSchema = Get-Content (Join-Path $script:SpecRoot 'actions.catalog.schema.json') -Raw | ConvertFrom-Json
        $catalogSchema.properties.bindings.items.pattern | Should -Be '^[a-z][a-z0-9]*$'
        $catalogSchema.'$defs'.action.properties.bindings.items.pattern | Should -Be '^[a-z][a-z0-9]*$'
    }
}

Describe 'A workspace extends the core by import' {
    It 'merges the core and its own actions, core first' {
        $r = Invoke-Workspace @{
            'actions.catalog.yaml' = "catalogVersion: 1`nimports: [{spec}/core.catalog.yaml]`nbindings: [go]`nactions:`n" + ($script:Action -f 'shop.order')
        }
        $r.ExitCode | Should -Be 0 -Because $r.Output
        @($r.Schema.'$defs'.step.properties.action.enum) | Should -Be @('core.noop', 'core.set', 'core.fail', 'core.sleep', 'core.record', 'wait', 'shop.order')
        Test-Declares $r.Schema.'$defs'.'step.shop.order' 'target' | Should -BeTrue
    }

    It 'resolves imports depth first, relative to the importing file' {
        $r = Invoke-Workspace @{
            'team/base.catalog.yaml' = "catalogVersion: 1`nimports: [{spec}/core.catalog.yaml]`nbindings: [go]`nactions:`n" + ($script:Action -f 'shop.list')
            'actions.catalog.yaml'   = "catalogVersion: 1`nimports: [team/base.catalog.yaml]`nbindings: [go]`nactions:`n" + ($script:Action -f 'shop.order')
        }
        $r.ExitCode | Should -Be 0 -Because $r.Output
        @($r.Schema.'$defs'.step.properties.action.enum)[-2..-1] | Should -Be @('shop.list', 'shop.order')
    }

    It 'refuses a name declared twice, naming both files' {
        $r = Invoke-Workspace @{
            'actions.catalog.yaml' = "catalogVersion: 1`nimports: [{spec}/core.catalog.yaml]`nbindings: [go]`nactions:`n" + ($script:Action -f 'core.set')
        }
        $r.ExitCode | Should -Not -Be 0
        $r.Output | Should -Match 'core\.set is declared twice'
        $r.Output | Should -Match 'core\.catalog\.yaml'
        $r.Output | Should -Match 'actions\.catalog\.yaml'
    }

    It 'refuses an import cycle' {
        $r = Invoke-Workspace @{
            'a.catalog.yaml'       = "catalogVersion: 1`nimports: [b.catalog.yaml]"
            'b.catalog.yaml'       = "catalogVersion: 1`nimports: [a.catalog.yaml]"
            'actions.catalog.yaml' = "catalogVersion: 1`nimports: [a.catalog.yaml]"
        }
        $r.ExitCode | Should -Not -Be 0
        $r.Output | Should -Match 'import cycle'
    }

    It 'folds an extension into the suite, defaults, a case and every step' {
        $r = Invoke-Workspace @{
            'shop.suite.json'      = '{ "suite": { "owner": { "type": "string" } }, "defaults": { "region": { "$ref": "#/$defs/region" } }, "case": { "region": { "$ref": "#/$defs/region" } }, "step": { "region": { "$ref": "#/$defs/region" } }, "$defs": { "region": { "enum": ["eu", "us"] } } }'
            'actions.catalog.yaml' = "catalogVersion: 1`nimports: [{spec}/core.catalog.yaml]`nsuiteSchema: [shop.suite.json]`nbindings: [go]`nactions:`n" + ($script:Action -f 'shop.order')
        }
        $r.ExitCode | Should -Be 0 -Because $r.Output
        $defs = $r.Schema.'$defs'
        Test-Declares $r.Schema 'owner' | Should -BeTrue
        foreach ($definition in @($defs.defaults, $defs.case, $defs.stepEnvelope, $defs.'step.meta', $defs.'step.shop.order', $defs.'step.core.set')) {
            Test-Declares $definition 'region' | Should -BeTrue
        }
        $defs.region.enum | Should -Be @('eu', 'us')
    }

    It 'refuses an extension that redefines <What>' -ForEach @(
        @{ What = 'a core suite field'; Json = '{ "suite": { "tags": { "type": "string" } } }'; Says = 'the suite already has tags' }
        @{ What = 'a core step field'; Json = '{ "step": { "captureAs": { "type": "string" } } }'; Says = 'a step already has captureAs' }
        @{ What = 'a core definition'; Json = '{ "$defs": { "assert": { "type": "object" } } }'; Says = 'defs already has assert' }
        @{ What = 'something it may not touch'; Json = '{ "tests": {} }'; Says = 'not tests' }
    ) {
        $r = Invoke-Workspace @{
            'bad.suite.json'       = $Json
            'actions.catalog.yaml' = "catalogVersion: 1`nimports: [{spec}/core.catalog.yaml]`nsuiteSchema: [bad.suite.json]"
        }
        $r.ExitCode | Should -Not -Be 0
        $r.Output | Should -Match ([regex]::Escape($Says))
    }
}
