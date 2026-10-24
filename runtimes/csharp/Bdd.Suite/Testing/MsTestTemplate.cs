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
    public static string Suite(PlanSuite suite, TestsConfig config, string ns) =>
        config.Host == "taef" ? TaefSuite(suite, config, ns) : MsTestSuite(suite, config, ns);

    /// <summary>The run hook and the MSTest verdicts, once per test assembly.</summary>
    public static string Assembly(IReadOnlyList<TestsConfig> configs) =>
        configs.Any(config => config.Host == "taef") ? TaefAssembly(configs) : MsTestAssembly(configs);

    private static string MsTestSuite(PlanSuite suite, TestsConfig config, string ns)
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

    private static string MsTestAssembly(IReadOnlyList<TestsConfig> configs)
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

    /// <summary>
    /// One suite's test class for TAEF (DEC-T14). TAEF runs MSTest-attributed
    /// tests, but its CoreCLR host refuses MSTest's TestContext in any fixture
    /// ("It must be WEX.TestExecution.Markup.TestContext"), so nothing here
    /// takes one: the class opens its session on its first test instead of in
    /// <c>[ClassInitialize]</c> (the session runs the suite setup from that
    /// test's beforeEach, as it does for every provider), and each test names
    /// its own method for beforeEach and afterEach instead of reading
    /// TestContext.TestName. A failed afterEach fails its test, since there is
    /// no separate cleanup verdict to carry it.
    /// </summary>
    private static string TaefSuite(PlanSuite suite, TestsConfig config, string ns)
    {
        var code = new StringBuilder(CSharpCode.Header("mstest (taef)", suite.File));
        code.Append($$"""

            namespace {{ns}};

            /// <summary>The suite {{CSharpCode.Xml(suite.Name)}} ({{CSharpCode.Xml(suite.File)}}).</summary>
            [{{Mst}}.TestClass]
            public sealed class Suite_{{suite.Id}}
            {
                private static readonly object Gate = new();
                private static global::Bdd.Suite.Testing.SuiteTests? Session;

                private static global::Bdd.Suite.Testing.SuiteTests Open()
                {
                    lock (Gate)
                    {
                        if (Session is null)
                        {
                            {{Glue}}.Start();
            {{CSharpCode.Open(suite, config, "                ")}}
                        }
                        return Session;
                    }
                }

                [{{Mst}}.ClassCleanup]
                public static void Teardown() => {{Glue}}.Teardown(Session);

            """);
        foreach (var one in suite.Cases)
        {
            code.Append($"\n    [{Mst}.TestMethod(DisplayName = {CSharpCode.Literal(one.Name)})]\n");
            foreach (var tag in one.Tags)
            {
                code.Append($"    [{Mst}.TestCategory({CSharpCode.Literal(tag)})]\n");
            }
            code.Append($"    public void {one.Id}() => {Glue}.Case(Open(), {CSharpCode.Literal(one.Id)}, {CSharpCode.Literal(one.Name)});\n");
        }
        code.Append("}\n");
        return code.ToString();
    }

    /// <summary>The run hook and the verdicts for TAEF (DEC-T14): the run starts
    /// on the first test, from the environment alone (TAEF passes no MSTest run
    /// settings), and stops in <c>[AssemblyCleanup]</c>, which takes no context.</summary>
    private static string TaefAssembly(IReadOnlyList<TestsConfig> configs)
    {
        return CSharpCode.Header("mstest (taef)", CSharpCode.Sources(configs)) + $$"""

            namespace {{CSharpCode.GlueNamespace}};

            /// <summary>The run context: started once, by the first test, and its
            /// trace written once after the last (spec/session.md). TAEF's CoreCLR
            /// host refuses MSTest's TestContext, so the run's inputs come from the
            /// environment only.</summary>
            [{{Mst}}.TestClass]
            public sealed class BddSuiteAssembly
            {
                [{{Mst}}.AssemblyCleanup]
                public static void Stop() => BddSuiteMsTest.Stop();
            }

            /// <summary>How a session's results become verdicts under TAEF: a case
            /// that did not pass fails its test, a skipped one is inconclusive with
            /// its reason, a failed afterEach fails the test it ran after, and a
            /// failed suite teardown fails the class cleanup.</summary>
            internal static class BddSuiteMsTest
            {
                private static readonly object Gate = new();
                private static bool started;

                internal static void Start()
                {
                    lock (Gate)
                    {
                        if (!started)
                        {
                            global::Bdd.Suite.Testing.BddSuiteRun.Start(_ => null{{CSharpCode.Extensions(configs)}});
                            started = true;
                        }
                    }
                }

                internal static void Stop()
                {
                    lock (Gate)
                    {
                        if (started)
                        {
                            global::Bdd.Suite.Testing.BddSuiteRun.Stop();
                            started = false;
                        }
                    }
                }

                internal static void Case(global::Bdd.Suite.Testing.SuiteTests suite, string method, string caseName)
                {
                    suite.BeforeEach(method);
                    global::Bdd.Suite.Execution.CaseResult result;
                    try
                    {
                        result = suite.Run(caseName);
                    }
                    catch
                    {
                        // The case lock is released by afterEach; an exception the
                        // session did not turn into a result still lets the next case run.
                        suite.AfterEach(method);
                        throw;
                    }
                    var after = suite.AfterEach(method);
                    if (result.Status != "passed" && result.Status != "skipped")
                    {
                        {{Mst}}.Assert.Fail(after.AfterEachFailed ? result.Message + " Then afterEach failed: " + after.Message : result.Message);
                    }
                    if (after.AfterEachFailed)
                    {
                        {{Mst}}.Assert.Fail("afterEach failed: " + after.Message);
                    }
                    if (result.Status == "skipped")
                    {
                        Skip(result.Message);
                    }
                }

                /// <summary>TAEF counts MSTest's Inconclusive as a failure, so a skipped
                /// case logs TAEF's own Skipped result (WEX.Logging.Interop.Log.Result)
                /// when the host has TAEF's logger; elsewhere it stays Inconclusive.</summary>
                private static void Skip(string message)
                {
                    var log = TaefType("WEX.Logging.Interop.Log");
                    var results = TaefType("WEX.Logging.Interop.TestResults");
                    var logResult = results is null ? null : log?.GetMethod("Result", new[] { results, typeof(string) });
                    if (logResult is not null)
                    {
                        logResult.Invoke(null, new object[] { global::System.Enum.Parse(results!, "Skipped"), message });
                        return;
                    }
                    {{Mst}}.Assert.Inconclusive(message);
                }

                private static global::System.Type? TaefType(string name)
                {
                    foreach (var assembly in global::System.AppDomain.CurrentDomain.GetAssemblies())
                    {
                        if (assembly.GetType(name, throwOnError: false) is { } loaded)
                        {
                            return loaded;
                        }
                    }
                    try
                    {
                        return global::System.Reflection.Assembly.Load("Wex.Logger.Interop").GetType(name, throwOnError: false);
                    }
                    catch (global::System.Exception)
                    {
                        return null;
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
