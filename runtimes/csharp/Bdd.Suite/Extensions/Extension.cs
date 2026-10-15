using Bdd.Suite.Actions;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Model;
using Bdd.Suite.Validation;

namespace Bdd.Suite.Extensions;

// The extension API (DEC-S03): how code outside this runtime adds to it
// without editing it. An extension may add any of five things:
//
//   actions      name to handler, each handler seeing its extension's per-run state
//   context keys names readable in ${...} and known to dataflow lint
//   options      command-line flags the extension declares and reads
//   rules        extra lint rules, and a limit a case may not exceed at run time
//   env prefix   the prefix of the parameter and record variables
//
// A consumer builds its own suiterun from the runtime and its extensions:
//
//   return Runner.Run(args, Console.Out, Console.Error, new MyExtension());
//
// Several extensions compose; a name two of them define, or one that clashes
// with the core, is refused when they are composed, before anything runs.

/// <summary>One action an extension registers: its name and its
/// handler.</summary>
public sealed record ActionRegistration(string Name, Func<ActionRequest, object?> Handler);

/// <summary>A command-line flag an extension takes, always with a value:
/// <c>--region &lt;value&gt;</c>.</summary>
public sealed record ExtensionOption(string Flag, string Description);

/// <summary>One import a suite names, in reading order, so an extension's rule
/// can see what a suite brings in.</summary>
/// <param name="Import">The path as the suite writes it.</param>
/// <param name="Pointer">Where the suite writes it, e.g. /imports/0.</param>
/// <param name="File">The absolute path the import resolves to.</param>
public sealed record SuiteImport(string Import, string Pointer, string File);

/// <summary>What a lint rule sees: one parsed suite file and what its imports
/// declare.</summary>
public sealed class RuleInput
{
    public required SuiteDocument Document { get; init; }

    /// <summary>Relative to the workspace root, as findings report it.</summary>
    public required string File { get; init; }

    public required OrderedMap Suite { get; init; }

    /// <summary>What the suite's imports declare, and the imports
    /// themselves.</summary>
    public required Library Library { get; init; }

    /// <summary>Every import the suite names, in order.</summary>
    public IReadOnlyList<SuiteImport> Imports => Library.Imports;
}

/// <summary>An extension's lint rules and limits. Either may be
/// null.</summary>
public sealed class ExtensionRules
{
    /// <summary>No rule and no limit.</summary>
    public static ExtensionRules None { get; } = new();

    /// <summary>Findings beyond the core's, positioned like every other
    /// (diagnostics.md).</summary>
    public Func<RuleInput, IEnumerable<Diagnostic>>? Lint { get; init; }

    /// <summary>The limit a case runs under, given the suite and the limit the
    /// case declares; the smaller of the two applies.</summary>
    public Func<OrderedMap, long, long>? CaseLimitSec { get; init; }
}

/// <summary>What one run of an extension provides, from the values of its
/// options.</summary>
public sealed class RunState
{
    /// <summary>A value for each context key, as ${key} reads it. A value given
    /// here wins over the suite's defaults; a declared key with neither reads as
    /// an empty string.</summary>
    public IReadOnlyDictionary<string, object?>? Context { get; init; }

    /// <summary>Applied to every text a report carries, e.g. to hide
    /// secrets.</summary>
    public Func<string, string>? Redact { get; init; }

    /// <summary>Handed to this extension's actions as
    /// <see cref="ActionRequest.State"/>.</summary>
    public object? State { get; init; }
}

/// <summary>
/// One extension of this runtime. Every member but <see cref="Name"/> has a
/// default, so an extension implements only the parts it adds.
/// </summary>
public interface IExtension
{
    /// <summary>Shown in errors about this extension.</summary>
    string Name { get; }

    IReadOnlyList<ActionRegistration> Actions => [];

    IReadOnlyList<string> ContextKeys => [];

    IReadOnlyList<ExtensionOption> Options => [];

    ExtensionRules Rules => ExtensionRules.None;

    /// <summary>The prefix of PARAM_&lt;NAME&gt; and RECORD_PATH; BDD_SUITE_
    /// when no extension sets one.</summary>
    string? EnvPrefix => null;

    /// <summary>Called once per run, with the values given for this
    /// extension's options (flag to value).</summary>
    RunState Start(IReadOnlyDictionary<string, string> options) => new();
}

/// <summary>An extension written as a value rather than a class: every part
/// is a property, and <see cref="OnStart"/> is what <see cref="Start"/>
/// calls.</summary>
public sealed class Extension : IExtension
{
    public required string Name { get; init; }

    public IReadOnlyList<ActionRegistration> Actions { get; init; } = [];

    public IReadOnlyList<string> ContextKeys { get; init; } = [];

    public IReadOnlyList<ExtensionOption> Options { get; init; } = [];

    public ExtensionRules Rules { get; init; } = ExtensionRules.None;

    public string? EnvPrefix { get; init; }

    public Func<IReadOnlyDictionary<string, string>, RunState>? OnStart { get; init; }

    public RunState Start(IReadOnlyDictionary<string, string> options) => OnStart?.Invoke(options) ?? new RunState();
}

/// <summary>Why extensions cannot be composed. The message is what the tool
/// prints.</summary>
public sealed class ExtensionException(string message) : Exception(message);
