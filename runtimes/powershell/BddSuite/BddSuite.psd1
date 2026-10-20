@{
    RootModule        = 'BddSuite.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '5d0f8a3e-6b2c-4f0e-9a51-3c7e2b9d4a10'
    Author            = 'bdd-code-extension contributors'
    Description       = 'The PowerShell runtime of the BDD suite format: suite model, lint, step execution, expressions, assertions, report comparison, the action registry, the core actions and the generic runner (Invoke-BddSuite), extensible by modules (README.md).'
    PowerShellVersion = '7.2'
    FunctionsToExport = @(
        # The runner and the extension API.
        'Invoke-BddSuite', 'Import-SuiteExtension', 'New-SuiteComposite', 'Start-SuiteExtension', 'Protect-SuiteText',
        'Get-SuiteCaseLimitSec', 'Initialize-SuiteActionRegistry', 'Import-SuiteActionSource', 'Get-SuiteRunLoad',
        # The session a test framework drives a suite through (spec/session.md), and the Pester glue.
        'New-BddSuiteRunContext', 'Open-BddSuiteSession', 'Invoke-BddSuiteSetup', 'Invoke-BddSuiteBeforeEach', 'Invoke-BddSuiteCase',
        'Invoke-BddSuiteAfterEach', 'Invoke-BddSuiteTeardown', 'Invoke-BddSuiteTest', 'Complete-BddSuiteSession', 'Write-BddSuiteTrace',
        'Get-BddSuiteTestContext', 'Reset-BddSuiteTestContext', 'Copy-SuiteBagValue',
        # suiterun generate: the test plan and the Pester tests (spec/test-plan.md).
        'Invoke-BddSuiteGenerate', 'Read-BddSuiteTestsConfig', 'Select-BddSuiteFile', 'Get-BddSuitePlan', 'ConvertTo-BddSuitePlanJson',
        'ConvertTo-BddSuitePesterFile', 'Write-BddSuiteGeneratedFile', 'Get-BddSuiteIdentifier', 'Test-BddSuiteOfflineAction', 'ConvertTo-BddSuitePesterText',
        # The command line (suiterun).
        'Invoke-BddSuiteCli', 'Get-BddSuiteCliUsage', 'ConvertFrom-BddSuiteCliArgument', 'Resolve-BddSuiteCliPath',
        'Get-BddSuiteCliCase', 'ConvertTo-BddSuiteCliJson',
        # The action registry.
        'Register-SuiteAction', 'Set-SuiteActionOwner', 'Get-SuiteAction', 'Get-SuiteActionOwner', 'Get-SuiteActionNames',
        'Reset-SuiteActionRegistry',
        # Lint.
        'Invoke-SuiteLint', 'Invoke-SuiteLintFile', 'Format-SuiteDiagnostic', 'Test-SuiteDiagnosticFailure',
        'Get-SortedSuiteDiagnostic', 'Get-SuiteNodePosition', 'Get-SuiteWorkspaceRoot', 'Resolve-SuiteRoot',
        'Import-SuiteSchema', 'Read-SuiteCatalog', 'Get-NearestSpelling', 'Get-EditDistance', 'Test-CapturePath',
        'New-SuiteDiagnostic', 'Get-KeyList', 'Get-TableColumn', 'Test-SuiteTable', 'Get-SuiteStepList',
        'Split-SchemaErrorPointer', 'Read-ExpressionReference', 'Invoke-SchemaValidation', 'Test-SuiteJson',
        'ConvertFrom-SuiteYaml', 'Get-SuiteAllStepEntry',
        # The suite model.
        'Copy-SuiteValue', 'Expand-MetaParameter', 'Get-MetaStepDefinition', 'Expand-SuiteStepList', 'Resolve-SuiteKeyword',
        'Format-StepLabel', 'Import-SuiteLibrary', 'Resolve-SuiteParameter', 'Expand-SuiteOutline', 'Format-TableRow',
        # Step execution.
        'Expand-SuiteValue', 'Get-AssertionActual', 'Test-Assertion', 'Get-StepLimitSec', 'New-StepRunspace',
        'Close-StepRunspace', 'Stop-StepPipeline', 'Invoke-BoundedAction', 'Invoke-SuiteStep', 'New-StepFailure',
        'Get-StepFailureReason', 'Test-SuiteCapturePath',
        # Expressions and assertions.
        'Invoke-SuiteExpression', 'Expand-SuiteExpression', 'Get-ExpressionFunctionName', 'Get-ExpressionRoot',
        'ConvertTo-ExpressionToken', 'Resolve-ExpressionPath', 'Invoke-ExpressionFunction', 'Compare-ExpressionValue',
        'Invoke-ExpressionOperator', 'Get-SuiteAssertionOperator', 'Test-SuiteComparison', 'Format-AssertionFailure',
        # Reports.
        'ConvertTo-CanonicalReport', 'Test-ReportsEqual', 'Get-CanonicalReportElement', 'Get-FirstReportDifference',
        'ConvertTo-SortedJsonLine', 'ConvertTo-SortedJsonValue', 'New-NUnit3Xml', 'New-JUnitXml'
    )
    AliasesToExport   = @('Register-LabAction', 'Get-LabActionNames', 'Get-LabAction')
    CmdletsToExport   = @()
    VariablesToExport = @()
    RequiredModules   = @()
    PrivateData       = @{ PSData = @{ Tags = @('bdd', 'suite', 'yaml') } }
}
