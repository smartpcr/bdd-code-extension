using System.Text;
using Bdd.Suite.Extensions;

namespace Bdd.Suite.Cli;

/// <summary>What the tool was asked to do.</summary>
public enum Verb
{
    Lint,
    Run,
    List,
    Actions,
    Generate,
}

/// <summary>Which report a run writes.</summary>
public enum ReportFormat
{
    NUnit3,
    JUnit,
}

/// <summary>The three exit codes every binding shares.</summary>
public static class Exit
{
    /// <summary>Every selected case passed, or the validation found nothing.</summary>
    public const int Passed = 0;

    /// <summary>A case failed. Only a run can produce this.</summary>
    public const int Failed = 1;

    /// <summary>A validation error, or the harness could not do its job at all.</summary>
    public const int Refused = 2;
}

/// <summary>One parsed command line.</summary>
public sealed class Options
{
    public Verb Verb { get; set; }
    public string Path { get; set; } = string.Empty;
    public List<string> Tags { get; } = [];

    /// <summary>Case-name globs (`*`, `?`) from `--name`: a case is selected when
    /// its name matches any of them and the tag filter selects it. Empty selects
    /// every case (spec/README.md, docs/packages DEC-P05).</summary>
    public List<string> Names { get; } = [];

    /// <summary>`--progress`: live lines while a run goes, in the shape
    /// spec/progress.md gives.</summary>
    public bool Progress { get; set; }

    public string Results { get; set; } = string.Empty;
    public string TraceFile { get; set; } = string.Empty;

    /// <summary>`--events`: the file the run writes its step events to, one JSON
    /// object per line, as it goes (spec/events.md).</summary>
    public string Events { get; set; } = string.Empty;

    /// <summary>`--cancel-on-stdin-close`: cancel the run when standard input
    /// reaches its end (spec/events.md, "Cancel"). Opt-in, because a runner
    /// started with no standard input would otherwise cancel itself.</summary>
    public bool CancelOnStdinClose { get; set; }

    /// <summary>`--cancel-file`: cancel the run when this file appears.</summary>
    public string CancelFile { get; set; } = string.Empty;

    public ReportFormat Format { get; set; } = ReportFormat.NUnit3;

    /// <summary>The --param pairs, in the order they were given, because a later
    /// one replaces an earlier one and a message names the first.</summary>
    public List<KeyValuePair<string, string>> Params { get; } = [];

    public string Binding { get; set; } = "csharp";
    public bool Json { get; set; }
    public bool Strict { get; set; }
    public bool DryRun { get; set; }
    public bool BindingCheck { get; set; }
    public string SchemaRoot { get; set; } = string.Empty;

    /// <summary>The value given for each option an extension declares, by
    /// flag. A runtime with no extension takes none.</summary>
    public Dictionary<string, string> ExtensionOptions { get; } = new(StringComparer.Ordinal);

    /// <summary>generate: the bddsuite.tests.yaml files (spec/test-plan.md).</summary>
    public List<string> Configs { get; } = [];

    /// <summary>generate: print the plan instead of writing code.</summary>
    public bool Plan { get; set; }

    /// <summary>generate: say which files differ instead of writing them.</summary>
    public bool Check { get; set; }

    /// <summary>generate: the provider, over the config's and the detected one.</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>generate: the folder the code is written to.</summary>
    public string Out { get; set; } = string.Empty;

    /// <summary>generate: the test project's package references, which identify
    /// its provider when nothing names one.</summary>
    public List<string> Packages { get; } = [];
}

/// <summary>Why a command line could not be read.</summary>
public sealed class CommandLineException(string message) : Exception(message);

/// <summary>
/// The command line every runtime shares.
///
/// DEC-Y14 gives every runtime the same verbs:
///
///   suiterun lint    --path &lt;glob&gt; [--json] [--strict] [--binding-check] [--binding &lt;name&gt;]
///   suiterun run     --path &lt;glob&gt; [--tags a,b] [--results f.xml] [--format nunit3|junit]
///                    [--dry-run] [--param name=value] [--trace-file f.json]
///                    [--events f.jsonl] [--cancel-on-stdin-close] [--cancel-file &lt;path&gt;]
///                    [any option an extension declares, with its value]
///   suiterun list    --path &lt;glob&gt; [--tags a,b]
///   suiterun actions [--json]
///
/// The options a product needs (an address, an environment's name) are not the
/// core's: an extension declares them (DEC-S03), and each is a flag with a
/// value, read like the core's own.
///
/// Parsed by hand rather than with a parsing library, because the exit codes are
/// part of the contract: an unknown argument is 2, and a library's own error
/// handling exits with whatever it happens to use and no verb in the message.
/// </summary>
public static class CommandLine
{
    /// <summary>The text a refusal prints beside its own message.</summary>
    public const string Usage = """
        suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
        suiterun run     --path <glob> [--tags a,b] [--name a*,b?] [--results f.xml] [--format nunit3|junit]
                         [--dry-run] [--param name=value] [--trace-file f.json] [--progress]
                         [--events f.jsonl] [--cancel-on-stdin-close] [--cancel-file <path>]
        suiterun list    --path <glob> [--tags a,b] [--name a*,b?]
        suiterun actions [--json]
        suiterun generate --config <bddsuite.tests.yaml> [--config <another>] [--provider <name>]
                         [--out <folder>] [--packages a;b] [--plan | --check]
        """;

    /// <summary>The usage text, with every option the extensions
    /// declare.</summary>
    public static string UsageFor(Composite? extensions)
    {
        if (extensions is null || extensions.Options.Count == 0)
        {
            return Usage;
        }
        var text = new StringBuilder(Usage);
        text.Append("\nOptions the extensions add, for run:");
        foreach (var option in extensions.Options)
        {
            text.Append("\n                 ").Append(option.Flag).Append(" <value>  ").Append(option.Description);
        }
        return text.ToString();
    }

    /// <summary>The name a verb is written as on the command line.</summary>
    public static string Spell(Verb verb) => verb switch
    {
        Verb.Lint => "lint",
        Verb.Run => "run",
        Verb.List => "list",
        Verb.Generate => "generate",
        _ => "actions",
    };

    /// <summary>The name a report format is written as.</summary>
    public static string Spell(ReportFormat format) =>
        format == ReportFormat.JUnit ? "junit" : "nunit3";

    /// <summary>Read one command line, or say why it cannot be read. An option
    /// an extension declares is a flag with a value, like the core's.</summary>
    public static Options Parse(IReadOnlyList<string> arguments, Composite? extensions = null)
    {
        var usage = UsageFor(extensions);
        var extensionFlags = (extensions?.Options ?? []).Select(option => option.Flag).ToHashSet(StringComparer.Ordinal);
        var options = new Options();
        if (arguments.Count == 0)
        {
            throw new CommandLineException($"a verb is needed.\n{usage}");
        }

        options.Verb = arguments[0] switch
        {
            "lint" => Verb.Lint,
            "run" => Verb.Run,
            "list" => Verb.List,
            "actions" => Verb.Actions,
            "generate" => Verb.Generate,
            _ => throw new CommandLineException($"there is no verb called {arguments[0]}.\n{usage}"),
        };

        var index = 1;

        // Every flag that takes a value reads the next argument, and says so
        // rather than silently treating the next flag as its value.
        string Value(string name)
        {
            index++;
            if (index >= arguments.Count || arguments[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new CommandLineException($"{name} needs a value after it");
            }
            return arguments[index];
        }

        for (; index < arguments.Count; index++)
        {
            var name = arguments[index];
            switch (name)
            {
                case "--path":
                    options.Path = Value(name);
                    break;
                case "--tags":
                    foreach (var tag in Value(name).Split(','))
                    {
                        var trimmed = tag.Trim();
                        if (trimmed.Length > 0)
                        {
                            options.Tags.Add(trimmed);
                        }
                    }
                    break;
                case "--name":
                    foreach (var pattern in Value(name).Split(','))
                    {
                        var trimmed = pattern.Trim();
                        if (trimmed.Length > 0)
                        {
                            options.Names.Add(trimmed);
                        }
                    }
                    break;
                case "--progress":
                    options.Progress = true;
                    break;
                case "--results":
                    options.Results = Value(name);
                    break;
                case "--trace-file":
                    options.TraceFile = Value(name);
                    break;
                case "--events":
                    options.Events = Value(name);
                    break;
                case "--cancel-on-stdin-close":
                    options.CancelOnStdinClose = true;
                    break;
                case "--cancel-file":
                    options.CancelFile = Value(name);
                    break;
                case "--schema-root":
                    options.SchemaRoot = Value(name);
                    break;
                case "--binding":
                    options.Binding = Value(name);
                    break;
                case var flag when extensionFlags.Contains(flag):
                    options.ExtensionOptions[flag] = Value(flag);
                    break;
                case "--format":
                    var format = Value(name);
                    options.Format = format switch
                    {
                        "nunit3" => ReportFormat.NUnit3,
                        "junit" => ReportFormat.JUnit,
                        _ => throw new CommandLineException($"--format is nunit3 or junit, not {format}"),
                    };
                    break;
                case "--param":
                    var pair = Value(name);
                    var at = pair.IndexOf('=', StringComparison.Ordinal);
                    if (at <= 0)
                    {
                        throw new CommandLineException($"--param takes name=value, and {pair} is not one");
                    }
                    options.Params.Add(new KeyValuePair<string, string>(pair[..at], pair[(at + 1)..]));
                    break;
                case "--json":
                    options.Json = true;
                    break;
                case "--strict":
                    options.Strict = true;
                    break;
                case "--dry-run":
                    options.DryRun = true;
                    break;
                case "--binding-check":
                    options.BindingCheck = true;
                    break;
                case "--config" when options.Verb == Verb.Generate:
                    options.Configs.Add(Value(name));
                    break;
                case "--plan" when options.Verb == Verb.Generate:
                    options.Plan = true;
                    break;
                case "--check" when options.Verb == Verb.Generate:
                    options.Check = true;
                    break;
                case "--provider" when options.Verb == Verb.Generate:
                    options.Provider = Value(name);
                    break;
                case "--out" when options.Verb == Verb.Generate:
                    options.Out = Value(name);
                    break;
                case "--packages" when options.Verb == Verb.Generate:
                    options.Packages.AddRange(Value(name).Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                    break;
                default:
                    throw new CommandLineException($"{Spell(options.Verb)} does not take {name}.\n{usage}");
            }
        }

        // A verb that reads files needs to be told which. `actions` reads the
        // catalog and nothing else, so it is the one that does not.
        if (options.Verb == Verb.Generate)
        {
            if (options.Configs.Count == 0)
            {
                throw new CommandLineException($"generate needs --config.\n{usage}");
            }
            if (options.Plan && options.Check)
            {
                throw new CommandLineException("generate takes --plan or --check, not both");
            }
            return options;
        }
        if (options.Verb != Verb.Actions && options.Path.Length == 0)
        {
            throw new CommandLineException($"{Spell(options.Verb)} needs --path.\n{usage}");
        }
        return options;
    }
}
