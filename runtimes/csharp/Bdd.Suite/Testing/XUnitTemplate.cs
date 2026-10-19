using System.Text;

namespace Bdd.Suite.Testing;

/// <summary>
/// The xUnit v3 provider (DEC-T05): per suite a class fixture
/// (<c>Suite_&lt;id&gt;_Fixture</c>, <c>IAsyncLifetime</c>) whose initialisation is
/// the suite setup and whose disposal is the teardown; the test class's own
/// <c>IAsyncLifetime</c>, implemented explicitly so no case name can collide with
/// it, for beforeEach and afterEach; one <c>[Fact(DisplayName = ...)]</c> per case
/// and per examples row (a Theory row's name gets its arguments appended, T0);
/// <c>[Trait("Category", ...)]</c> per tag; and the run context as an assembly
/// fixture.
/// </summary>
public static class XUnitTemplate
{
    private const string X = "global::Xunit";
    private const string Task = "global::System.Threading.Tasks.ValueTask";
    private const string Glue = "global::" + CSharpCode.GlueNamespace + ".BddSuiteXunit";
    private const string Method = X + ".TestContext.Current.TestMethod!.MethodName";

    /// <summary>One suite's fixture and test class.</summary>
    public static string Suite(PlanSuite suite, TestsConfig config, string ns)
    {
        var code = new StringBuilder(CSharpCode.Header("xunit", suite.File));
        code.Append($$"""

            namespace {{ns}};

            /// <summary>The suite setup and teardown of {{CSharpCode.Xml(suite.Name)}}: once for
            /// the class, around every test of it.</summary>
            public sealed class Suite_{{suite.Id}}_Fixture : {{X}}.IAsyncLifetime
            {
                public global::Bdd.Suite.Testing.SuiteTests Session { get; private set; } = null!;

                public {{Task}} InitializeAsync()
                {
            {{CSharpCode.Open(suite, config, "        ")}}
                    Session.Setup();
                    return default;
                }

                public {{Task}} DisposeAsync()
                {
                    {{Glue}}.Teardown(Session);
                    return default;
                }
            }

            /// <summary>The suite {{CSharpCode.Xml(suite.Name)}} ({{CSharpCode.Xml(suite.File)}}).</summary>
            public sealed class Suite_{{suite.Id}} : {{X}}.IClassFixture<Suite_{{suite.Id}}_Fixture>, {{X}}.IAsyncLifetime
            {
                private readonly global::Bdd.Suite.Testing.SuiteTests Session;

                public Suite_{{suite.Id}}(Suite_{{suite.Id}}_Fixture fixture) => Session = fixture.Session;

                {{Task}} {{X}}.IAsyncLifetime.InitializeAsync()
                {
                    BeforeEach();
                    return default;
                }

                {{Task}} global::System.IAsyncDisposable.DisposeAsync()
                {
                    AfterEach();
                    return default;
                }

                private void BeforeEach() => Session.BeforeEach({{Method}});

                private void AfterEach() => {{Glue}}.AfterEach(Session, {{Method}});

            """);
        foreach (var one in suite.Cases)
        {
            code.Append($"\n    [{X}.Fact(DisplayName = {CSharpCode.Literal(one.Name)})]\n");
            foreach (var tag in one.Tags)
            {
                code.Append($"    [{X}.Trait(\"Category\", {CSharpCode.Literal(tag)})]\n");
            }
            code.Append($"    public void {one.Id}() => {Glue}.Report(Session.Run({CSharpCode.Literal(one.Name)}));\n");
        }
        code.Append("}\n");
        return code.ToString();
    }

    /// <summary>The run hook and the xUnit verdicts, once per test assembly.</summary>
    public static string Assembly(IReadOnlyList<TestsConfig> configs) =>
        CSharpCode.Header("xunit", CSharpCode.Sources(configs)) + $$"""

            [assembly: {{X}}.AssemblyFixture(typeof(global::{{CSharpCode.GlueNamespace}}.BddSuiteXunitRun))]

            namespace {{CSharpCode.GlueNamespace}};

            /// <summary>The run context: started once before any test class, its trace
            /// written once after the last (spec/session.md). xUnit hands test code no
            /// run settings, so the run's inputs come from the environment.</summary>
            public sealed class BddSuiteXunitRun : {{X}}.IAsyncLifetime
            {
                public {{Task}} InitializeAsync()
                {
                    global::Bdd.Suite.Testing.BddSuiteRun.Start(_ => null{{CSharpCode.Extensions(configs)}});
                    return default;
                }

                public {{Task}} DisposeAsync()
                {
                    global::Bdd.Suite.Testing.BddSuiteRun.Stop();
                    return default;
                }
            }

            /// <summary>How a session's results become xUnit verdicts: a case that did
            /// not pass fails its test, a skipped one is skipped with its reason, a failed
            /// afterEach fails the test's disposal, and a failed suite teardown fails the
            /// class fixture's disposal, which xUnit reports as a class cleanup failure
            /// and never against a passed test (T0).</summary>
            internal static class BddSuiteXunit
            {
                internal static void Report(global::Bdd.Suite.Execution.CaseResult result)
                {
                    switch (result.Status)
                    {
                        case "passed":
                            return;
                        case "skipped":
                            {{X}}.Assert.Skip(result.Message);
                            return;
                        default:
                            {{X}}.Assert.Fail(result.Message);
                            return;
                    }
                }

                internal static void AfterEach(global::Bdd.Suite.Testing.SuiteTests suite, string method)
                {
                    var result = suite.AfterEach(method);
                    if (result.AfterEachFailed)
                    {
                        {{X}}.Assert.Fail(result.Message);
                    }
                }

                internal static void Teardown(global::Bdd.Suite.Testing.SuiteTests? suite)
                {
                    if (suite?.Teardown() is { Failed: true } result)
                    {
                        {{X}}.Assert.Fail("The suite teardown of " + suite.Session.Name + " failed: " + result.Message);
                    }
                }
            }

            """;
}
