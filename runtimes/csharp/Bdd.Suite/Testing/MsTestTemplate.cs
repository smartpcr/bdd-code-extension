using System.Text;

namespace Bdd.Suite.Testing;

/// <summary>
/// The MSTest 4 provider (DEC-T05): one test class per suite, the suite setup
/// and teardown in <c>[ClassInitialize]</c> and <c>[ClassCleanup]</c>,
/// beforeEach and afterEach in <c>[TestInitialize]</c> and <c>[TestCleanup]</c>,
/// one <c>[TestMethod(DisplayName = ...)]</c> per case and per examples row,
/// <c>[TestCategory]</c> per tag, and the run context in
/// <c>[AssemblyInitialize]</c> and <c>[AssemblyCleanup]</c>. The MSTest-specific
/// verdicts (fail, inconclusive) are in the generated glue, so the
/// Bdd.Suite.Testing library depends on no test framework.
/// </summary>
public static class MsTestTemplate
{
    private const string Mst = "global::Microsoft.VisualStudio.TestTools.UnitTesting";
    private const string Glue = "global::" + CSharpCode.GlueNamespace + ".BddSuiteMsTest";

    /// <summary>One suite's test class.</summary>
    public static string Suite(PlanSuite suite, TestsConfig config, string ns)
    {
        var code = new StringBuilder(CSharpCode.Header("mstest", suite.File));
        code.Append($$"""

            namespace {{ns}};

            /// <summary>The suite {{CSharpCode.Xml(suite.Name)}} ({{CSharpCode.Xml(suite.File)}}).</summary>
            [{{Mst}}.TestClass]
            public sealed class Suite_{{suite.Id}}
            {
                private static global::Bdd.Suite.Testing.SuiteTests? Session;

                public {{Mst}}.TestContext TestContext { get; set; } = null!;

                [{{Mst}}.ClassInitialize]
                public static void Setup({{Mst}}.TestContext context)
                {
            {{CSharpCode.Open(suite, config, "        ")}}
                    Session.Setup();
                }

                [{{Mst}}.ClassCleanup]
                public static void Teardown() => {{Glue}}.Teardown(Session);

                [{{Mst}}.TestInitialize]
                public void BeforeEach() => Session!.BeforeEach(TestContext.TestName!);

                [{{Mst}}.TestCleanup]
                public void AfterEach() => {{Glue}}.AfterEach(Session!, TestContext.TestName!);

            """);
        foreach (var one in suite.Cases)
        {
            code.Append($"\n    [{Mst}.TestMethod(DisplayName = {CSharpCode.Literal(one.Name)})]\n");
            foreach (var tag in one.Tags)
            {
                code.Append($"    [{Mst}.TestCategory({CSharpCode.Literal(tag)})]\n");
            }
            code.Append($"    public void {one.Id}() => {Glue}.Report(Session!.Run({CSharpCode.Literal(one.Name)}));\n");
        }
        code.Append("}\n");
        return code.ToString();
    }

    /// <summary>The run hook and the MSTest verdicts, once per test assembly.</summary>
    public static string Assembly(IReadOnlyList<TestsConfig> configs)
    {
        return CSharpCode.Header("mstest", CSharpCode.Sources(configs)) + $$"""

            namespace {{CSharpCode.GlueNamespace}};

            /// <summary>The run context: started once before any test, its trace
            /// written once after the last (spec/session.md). Run settings
            /// parameters (TestContext.Properties) win over the environment.</summary>
            [{{Mst}}.TestClass]
            public sealed class BddSuiteAssembly
            {
                [{{Mst}}.AssemblyInitialize]
                public static void Start({{Mst}}.TestContext context) =>
                    global::Bdd.Suite.Testing.BddSuiteRun.Start(
                        name => context.Properties.TryGetValue(name, out var value) ? value as string : null{{CSharpCode.Extensions(configs)}});

                [{{Mst}}.AssemblyCleanup]
                public static void Stop() => global::Bdd.Suite.Testing.BddSuiteRun.Stop();
            }

            /// <summary>How a session's results become MSTest verdicts: a case that
            /// did not pass fails its test, a skipped one is inconclusive with its
            /// reason, a failed afterEach fails the test's cleanup, and a failed
            /// suite teardown fails the class cleanup, which MSTest 4 reports as
            /// its own row and never against a passed test (T0).</summary>
            internal static class BddSuiteMsTest
            {
                internal static void Report(global::Bdd.Suite.Execution.CaseResult result)
                {
                    switch (result.Status)
                    {
                        case "passed":
                            return;
                        case "skipped":
                            {{Mst}}.Assert.Inconclusive(result.Message);
                            return;
                        default:
                            {{Mst}}.Assert.Fail(result.Message);
                            return;
                    }
                }

                internal static void AfterEach(global::Bdd.Suite.Testing.SuiteTests suite, string method)
                {
                    var result = suite.AfterEach(method);
                    if (result.AfterEachFailed)
                    {
                        {{Mst}}.Assert.Fail(result.Message);
                    }
                }

                internal static void Teardown(global::Bdd.Suite.Testing.SuiteTests? suite)
                {
                    if (suite?.Teardown() is { Failed: true } result)
                    {
                        {{Mst}}.Assert.Fail("The suite teardown of " + suite.Session.Name + " failed: " + result.Message);
                    }
                }
            }

            """;
    }

}
