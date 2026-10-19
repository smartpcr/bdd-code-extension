using System.Globalization;
using Bdd.Suite.Cli;
using Bdd.Suite.Testing;

namespace Bdd.Suite.Run;

public static partial class Runner
{
    /// <summary>
    /// `generate`: build each config's test plan and write the provider's test
    /// code (spec/test-plan.md). With --plan, print the one config's plan; with
    /// --check, exit 1 naming each file that differs from what would be written.
    /// A suite that does not lint clean refuses the whole run (exit 2), writing
    /// nothing.
    /// </summary>
    public static Report Generate(Options options)
    {
        try
        {
            var configs = options.Configs.Select(TestsConfig.Load).ToList();
            var plans = new List<TestPlan>();
            var findings = new List<string>();
            foreach (var config in configs)
            {
                var built = TestPlan.Build(config);
                if (built.Plan is { } plan)
                {
                    plans.Add(plan);
                }
                else
                {
                    // MSBuild's canonical form, so a build that runs the generator
                    // reports each finding as an error at its file and position.
                    findings.AddRange(built.Findings.Select(finding => string.Create(CultureInfo.InvariantCulture,
                        $"{Path.GetFullPath(Path.Combine(config.Directory, finding.File))}({finding.Position.Line},{finding.Position.Column}): {finding.SeverityName} {finding.Code}: {finding.Message}")));
                }
            }
            if (findings.Count > 0)
            {
                findings.Add("Nothing was generated: every suite has to lint clean first.");
                return new Report { Errors = string.Join('\n', findings), Code = Exit.Refused };
            }
            if (options.Plan)
            {
                return plans.Count == 1
                    ? new Report { Out = plans[0].ToJson(), Code = Exit.Passed }
                    : Report.Refused("--plan prints one config's plan; give one --config.");
            }

            var provider = Providers.Choose(options.Provider, configs, options.Packages);
            var files = Generator.Render(plans, provider);
            var first = configs[0];
            var folder = options.Out.Length > 0
                ? Path.GetFullPath(options.Out)
                : Path.Combine(first.Directory, first.OutputFolder.Length > 0 ? first.OutputFolder : "generated");
            var outcome = Generator.Write(folder, files, options.Check);
            if (options.Check)
            {
                return outcome.Stale.Count == 0
                    ? new Report
                    {
                        Out = string.Create(CultureInfo.InvariantCulture, $"{files.Count} generated file(s) are up to date."),
                        Code = Exit.Passed,
                    }
                    : new Report
                    {
                        Out = string.Join('\n', outcome.Stale.Select(name => "stale: " + name)
                            .Append("Run suiterun generate to write them again.")),
                        Code = Exit.Failed,
                    };
            }
            var lines = outcome.Written.Select(name => "wrote " + name)
                .Concat(outcome.Removed.Select(name => "removed " + name)).ToList();
            lines.Add(string.Create(CultureInfo.InvariantCulture,
                $"{provider}: {plans.Sum(plan => plan.Suites.Count)} suite(s), {plans.Sum(plan => plan.Suites.Sum(suite => suite.Cases.Count))} test(s) in {folder}"));
            return new Report { Out = string.Join('\n', lines), Code = Exit.Passed };
        }
        catch (TestsConfigException failure)
        {
            return Report.Refused(failure.Message);
        }
        catch (IOException failure)
        {
            return Report.Refused(failure.Message);
        }
    }
}
