<#
.SYNOPSIS
    Says which part of the operator setup for the public registries is done
    (docs/packages, K8.1; implementation.md, section 6). Reads only.

.DESCRIPTION
    What GitHub can answer is checked through gh (an account with admin rights
    on the repository): the release environment, its required reviewer and
    its branch rule; the repository variables NUGET_USER and
    PUBLIC_REGISTRIES; the environment secret PSGALLERY_API_KEY (its name;
    a secret's value cannot be read). The registries' own settings (the npm
    org and trusted publisher, nuget.org's trusted publishing policy,
    crates.io's trusted publisher) are listed for the user to confirm, since
    only their owner can see them.

    Exits 0 when everything checkable is set, 1 otherwise. Prints no secret.

.EXAMPLE
    pwsh -File scripts/publish/Test-ReleaseSetup.ps1
#>
[CmdletBinding()]
param([string]$Repository = 'smartpcr/bdd-code-extension')

$ErrorActionPreference = 'Stop'
$missing = 0
function Report([bool]$Ok, [string]$What) {
    if ($Ok) { Write-Output "  done     $What" } else { Write-Output "  missing  $What"; $script:missing++ }
}
function Get-Api([string]$Path) {
    $answer = gh api $Path 2> $null
    if ($LASTEXITCODE) { return $null }
    return $answer | ConvertFrom-Json
}

Write-Output "Release setup of ${Repository}:"
$environment = Get-Api "repos/$Repository/environments/release"
Report ($null -ne $environment) 'the environment release'
$reviewers = @($environment.protection_rules | Where-Object { $_.type -eq 'required_reviewers' } | ForEach-Object { $_.reviewers })
Report ($reviewers.Count -gt 0) "release has a required reviewer$(if ($reviewers.Count) { " ($(@($reviewers | ForEach-Object { $_.reviewer.login ?? $_.reviewer.name }) -join ', '))" })"
$branches = $environment.deployment_branch_policy
Report ($null -ne $branches) 'release is limited to chosen branches (main)'

$secrets = @((Get-Api "repos/$Repository/environments/release/secrets").secrets | ForEach-Object { $_.name })
Report ($secrets -contains 'PSGALLERY_API_KEY') 'the release environment secret PSGALLERY_API_KEY'
# npm's first publish only: a trusted publisher is set on a package that exists.
Write-Output "  $(if ($secrets -contains 'NPM_TOKEN') { 'set    ' } else { 'not set' })  NPM_TOKEN, for npm's first publish (delete it once the package has its trusted publisher)"
Write-Output "  $(if ($secrets -contains 'CRATES_IO_TOKEN') { 'set    ' } else { 'not set' })  CRATES_IO_TOKEN, for crates.io's first publish (likewise)"

$nugetUser = Get-Api "repos/$Repository/actions/variables/NUGET_USER"
Report ($null -ne $nugetUser) 'the repository variable NUGET_USER (the nuget.org account of the trusted publishing policy)'
$public = Get-Api "repos/$Repository/actions/variables/PUBLIC_REGISTRIES"
Report ([bool]"$($public.value)".Trim()) "the repository variable PUBLIC_REGISTRIES (true, or a list such as nuget,npm,crates), set last (now: $(if ($public) { $public.value } else { 'not set' }))"

Write-Output 'For the registries'' owner to confirm (not visible from here):'
Write-Output '  npmjs.com     the org bdd-suite; a trusted publisher for this repository, workflow ci.yml, environment release'
Write-Output '  nuget.org     a trusted publishing policy for the same repository, workflow and environment'
Write-Output '  crates.io     suiterun published once by hand (crates.io needs the crate to exist), then a trusted publisher as above'
Write-Output '  Gallery       the API key in PSGALLERY_API_KEY may push BddSuite'

if ($missing) {
    Write-Output "$missing part(s) missing: the publish jobs stay off."
    exit 1
}
Write-Output 'Everything checkable is set.'
