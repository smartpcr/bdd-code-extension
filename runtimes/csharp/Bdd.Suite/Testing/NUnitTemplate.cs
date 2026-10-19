using System.Text;

namespace Bdd.Suite.Testing;

/// <summary>
/// The NUnit 4 provider (DEC-T05): one fixture per suite, the suite setup and
/// teardown in <c>[OneTimeSetUp]</c> and <c>[OneTimeTearDown]</c>, beforeEach and
/// afterEach in <c>[SetUp]</c> and <c>[TearDown]</c>, one parameterless method per
/// case and per examples row named exactly with <c>[TestCase(TestName = ...)]</c>,
/// <c>[Category]</c> per tag, and the run context in a <c>[SetUpFixture]</c> in
/// the global namespace, so it brackets every fixture. NUnit's name filter
/// breaks on a space, so one test is selected by its method
/// (<c>FullyQualifiedName=&lt;namespace&gt;.Suite_&lt;id&gt;.&lt;method&gt;</c>, T0).
/// </summary>
public static class NUnitTemplate
{
    private const string N = "global::NUnit.Framework";
    private const string Glue = "global::" + CSharpCode.GlueNamespace + ".BddSuiteNUnit";
    private const string Method = N + ".TestContext.CurrentContext.Test.MethodName!";

    /// <summary>One suite's fixture.</summary>
    public static string Suite(PlanSuite suite, TestsConfig config, string ns)
    {
        var code = new StringBuilder(CSharpCode.Header("nunit", suite.File));
        code.Append($$"""

            namespace {{ns}};

            /// <summary>The suite {{CSharpCode.Xml(suite.Name)}} ({{CSharpCode.Xml(suite.File)}}).</summary>
            [{{N}}.TestFixture]
            public sealed class Suite_{{suite.Id}}
            {
                private static global::Bdd.Suite.Testing.SuiteTests? Session;

                [{{N}}.OneTimeSetUp]
                public void Setup()
                {
            {{CSharpCode.Open(suite, config, "        ")}}
                    Session.Setup();
                }

                [{{N}}.OneTimeTearDown]
                public void Teardown() => {{Glue}}.Teardown(Session);

                [{{N}}.SetUp]
                public void BeforeEach() => Session!.BeforeEach({{Method}});

                [{{N}}.TearDown]
                public void AfterEach() => {{Glue}}.AfterEach(Session!, {{Method}});

            """);
        foreach (var one in suite.Cases)
        {
            code.Append($"\n    [{N}.TestCase(TestName = {CSharpCode.Literal(one.Name)})]\n");
            foreach (var tag in one.Tags)
            {
                code.Append($"    [{N}.Category({CSharpCode.Literal(tag)})]\n");
            }
            code.Append($"    public void {one.Id}() => {Glue}.Report(Session!.Run({CSharpCode.Literal(one.Name)}));\n");
        }
        code.Append("}\n");
        return code.ToString();
    }

    /// <summary>The run hook and the NUnit verdicts, once per test assembly.</summary>
    public static string Assembly(IReadOnlyList<TestsConfig> configs) =>
        CSharpCode.Header("nunit", CSharpCode.Sources(configs)) + $$"""

            /// <summary>The run context: started once before every fixture, its trace
            /// written once after the last (spec/session.md). In the global namespace,
            /// so it brackets every fixture of the assembly. Run settings parameters
            /// (TestContext.Parameters) win over the environment.</summary>
            [{{N}}.SetUpFixture]
            public sealed class BddSuiteNUnitRun
            {
                [{{N}}.OneTimeSetUp]
                public void Start() =>
                    global::Bdd.Suite.Testing.BddSuiteRun.Start(
                        name => {{N}}.TestContext.Parameters.Get(name){{CSharpCode.Extensions(configs)}});

                [{{N}}.OneTimeTearDown]
                public void Stop() => global::Bdd.Suite.Testing.BddSuiteRun.Stop();
            }

            namespace {{CSharpCode.GlueNamespace}}
            {
                /// <summary>How a session's results become NUnit verdicts: a case that did
                /// not pass fails its test, a skipped one is ignored with its reason, a
                /// failed afterEach fails the test's tear-down, and a failed suite teardown
                /// fails the one-time tear-down, which NUnit reports as a run-level error
                /// and never against a passed test (T0).</summary>
                internal static class BddSuiteNUnit
                {
                    internal static void Report(global::Bdd.Suite.Execution.CaseResult result)
                    {
                        switch (result.Status)
                        {
                            case "passed":
                                return;
                            case "skipped":
                                {{N}}.Assert.Ignore(result.Message);
                                return;
                            default:
                                {{N}}.Assert.Fail(result.Message);
                                return;
                        }
                    }

                    internal static void AfterEach(global::Bdd.Suite.Testing.SuiteTests suite, string method)
                    {
                        var result = suite.AfterEach(method);
                        if (result.AfterEachFailed)
                        {
                            {{N}}.Assert.Fail(result.Message);
                        }
                    }

                    internal static void Teardown(global::Bdd.Suite.Testing.SuiteTests? suite)
                    {
                        if (suite?.Teardown() is { Failed: true } result)
                        {
                            {{N}}.Assert.Fail("The suite teardown of " + suite.Session.Name + " failed: " + result.Message);
                        }
                    }
                }
            }

            """;
}
