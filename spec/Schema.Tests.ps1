<# .SYNOPSIS The generated schema says what an editor needs it to say. #>
<#
.DESCRIPTION
    Y7.3. An editor underlines a misspelled key because the schema declares the
    keys that are legal and closes the object against everything else. That is
    the whole mechanism, and it is a property of a file rather than of a screen,
    so it is asserted here.

    What this file does not assert is the squiggle. Nothing can: what an editor
    draws is between the YAML extension and the person looking at it.
    test/e2e/schema/README.md says what to look at, once, by hand.
#>

BeforeAll {
    $script:SchemaRoot = $PSScriptRoot
    $script:Schema = Get-Content (Join-Path $script:SchemaRoot 'suite.schema.json') -Raw | ConvertFrom-Json
    $script:Defs = $script:Schema.'$defs'

    function Get-Definition {
        param([string]$Name)
        $found = $script:Defs.PSObject.Properties | Where-Object Name -eq $Name
        if (-not $found) { throw "The generated schema declares no definition called $Name." }
        return $found.Value
    }

    function Test-Declares {
        param($Definition, [string]$Key)
        return [bool]($Definition.properties.PSObject.Properties | Where-Object Name -eq $Key)
    }
}

Describe 'Y7.3: the schema an editor reads' {
    It 'closes a case against a key nothing declares, which is what underlines <Wrong>' -ForEach @(
        @{ Definition = 'case'; Right = 'asserts'; Wrong = 'assert' }
        @{ Definition = 'case'; Right = 'timeoutSec'; Wrong = 'timeout' }
        @{ Definition = 'stepCommon'; Right = 'captureAs'; Wrong = 'capture' }
    ) {
        $definition = Get-Definition $Definition
        Test-Declares $definition $Right | Should -BeTrue -Because "$Definition declares $Right"
        Test-Declares $definition $Wrong | Should -BeFalse -Because "$Wrong is the mistake, not the key"
    }

    It 'closes <Definition> so an unknown key has something to be refused by' -ForEach @(
        @{ Definition = 'case' }
        @{ Definition = 'step.cluster.suspend' }
        @{ Definition = 'step.cluster.state' }
        @{ Definition = 'step.core.noop' }
        @{ Definition = 'metaStep' }
        @{ Definition = 'assert' }
    ) {
        # Without this an editor has no opinion about a key it has never heard
        # of, and neither has the lint: E101 and E105 both come from here.
        (Get-Definition $Definition).additionalProperties | Should -BeFalse
    }

    It 'gives <Action> exactly the parameters the catalog declares for it' -ForEach @(
        @{ Action = 'cluster.suspend'; Declares = 'node'; Refuses = 'nodee' }
        @{ Action = 'cluster.state'; Declares = 'captureAs'; Refuses = 'capturedAs' }
        @{ Action = 'core.set'; Declares = 'value'; Refuses = 'values' }
    ) {
        $definition = Get-Definition "step.$Action"
        Test-Declares $definition $Declares | Should -BeTrue
        Test-Declares $definition $Refuses | Should -BeFalse
    }

    It 'is a draft the YAML language server understands' {
        # redhat.vscode-yaml speaks draft 7 and 2020-12. A schema with no
        # $schema at all is guessed at, and a guess is what stops working
        # quietly one extension update later.
        $script:Schema.'$schema' | Should -Be 'https://json-schema.org/draft/2020-12/schema'
    }

    It 'maps every path the editor settings claim to a file that is there' {
        # .vscode/settings.json is committed, so a path that names nothing is a
        # mapping that silently does nothing for whoever opens the repository.
        $root = [IO.Path]::GetFullPath((Join-Path $script:SchemaRoot '../../..'))
        $settingsPath = Join-Path $root '.vscode/settings.json'
        Test-Path -LiteralPath $settingsPath | Should -BeTrue -Because 'Y7.3 commits the workspace mapping'

        # Comments are legal in a VS Code settings file and not in JSON, so they
        # come out before it is parsed.
        $text = (Get-Content -LiteralPath $settingsPath -Raw) -replace '(?m)^\s*//.*$', ''
        $settings = $text | ConvertFrom-Json
        $mapped = @($settings.'yaml.schemas'.'./test/e2e/schema/suite.schema.json')
        $mapped.Count | Should -BeGreaterThan 0

        foreach ($glob in $mapped) {
            $directory = Join-Path $root (Split-Path $glob -Parent)
            Test-Path -LiteralPath $directory | Should -BeTrue -Because "$glob names a directory that exists"
            @(Get-ChildItem -Path (Join-Path $root $glob) -File -ErrorAction SilentlyContinue).Count |
                Should -BeGreaterThan 0 -Because "$glob matches at least one suite"
        }
    }
}
