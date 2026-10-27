# The packages this workspace runs on: its package references, restored by
# restore.ps1 into .modules\ (a module path of this workspace's own, never the
# user's). Each entry names an exact version, and where its .nupkg comes from:
#
#   Nupkg       a URL (or a local path) of the package file itself.
#   Repository  a registered PSResource repository, such as PSGallery.
#
# BddSuite is the bdd-suite release these suites are written against. Install
# the Suite Authoring extension (asz.bdd-suite) of the same release: they carry
# the same core catalog and schema generator. Until BddSuite is on the
# PowerShell Gallery, its .nupkg is the release asset; the same package is on
# the GitHub Packages NuGet feed (restore.ps1 -Source <feed or folder>).
@{
    BddSuite          = @{
        Version = '0.7.12'
        Nupkg   = 'https://github.com/smartpcr/bdd-code-extension/releases/download/v0.7.12/BddSuite.0.7.12.nupkg'
    }
    # BddSuite's manifest requires it (RequiredModules) for reading YAML.
    'powershell-yaml' = @{
        Version    = '0.4.12'
        Repository = 'PSGallery'
    }
    # The generated tests are Pester 5 tests.
    Pester            = @{
        Version    = '5.7.1'
        Repository = 'PSGallery'
    }
}
