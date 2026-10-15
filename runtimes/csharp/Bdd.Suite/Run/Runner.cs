using Bdd.Suite.Cli;
using Bdd.Suite.Extensions;

namespace Bdd.Suite.Run;

/// <summary>What a verb produced: what to print, and the code to exit with.</summary>
public sealed class Report
{
    public string Out { get; init; } = string.Empty;
    public string Errors { get; init; } = string.Empty;
    public int Code { get; init; }

    public static Report Refused(string message) =>
        new() { Errors = message, Code = Exit.Refused };
}

/// <summary>
/// The four verbs, and the exit code each of them leaves.
///
/// Kept in the library rather than in the command line so that the conformance
/// tests drive exactly what the command line drives. A test that exercised a
/// different path would prove the wrong thing.
///
/// A consumer builds its own suiterun from this runtime and its extensions
/// (DEC-S03): its Main is one call to <see cref="Run"/>.
/// </summary>
public static partial class Runner
{
    /// <summary>
    /// One command line, run with the given extensions, to an exit code.
    ///
    /// Extensions that clash, and a command line that cannot be read, are
    /// refused with exit 2 before anything runs. Nothing here exits the process.
    /// </summary>
    public static int Run(
        IReadOnlyList<string> arguments, TextWriter stdout, TextWriter stderr, params IExtension[] extensions)
    {
        Composite composite;
        Options options;
        try
        {
            composite = Composite.Compose(extensions);
            options = CommandLine.Parse(arguments, composite);
        }
        catch (Exception refused) when (refused is ExtensionException or CommandLineException)
        {
            stderr.WriteLine(refused.Message);
            return Exit.Refused;
        }
        var report = Execute(options, composite);
        if (report.Out.Length > 0)
        {
            stdout.WriteLine(report.Out);
        }
        if (report.Errors.Length > 0)
        {
            stderr.WriteLine(report.Errors);
        }
        return report.Code;
    }

    /// <summary>Do one command line, with the given extensions or the core
    /// alone.</summary>
    public static Report Execute(Options options, Composite? extensions = null)
    {
        var composite = extensions ?? Composite.CoreOnly;
        return options.Verb switch
        {
            Verb.Lint => Lint(options, composite),
            Verb.Run => RunSuites(options, composite),
            Verb.List => List(options),
            Verb.Actions => Actions(options, composite),
            _ => Report.Refused($"{options.Verb} is not a verb."),
        };
    }
}
