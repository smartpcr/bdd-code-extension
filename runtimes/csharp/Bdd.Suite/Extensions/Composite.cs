using System.Globalization;
using System.Text.RegularExpressions;
using Bdd.Suite.Actions;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Expressions;
using Bdd.Suite.Model;

namespace Bdd.Suite.Extensions;

/// <summary>One action of the composite: its handler, and the extension that
/// registered it (<see cref="Owner"/> is -1 for the core). The core's
/// <c>wait</c> has no handler: it runs another step, so the executor runs
/// it.</summary>
public sealed record RegisteredAction(Func<ActionRequest, object?>? Handler, int Owner, string OwnerName);

/// <summary>
/// Every extension of one runtime, merged and checked.
///
/// A name two extensions both define, or one an extension takes from the core,
/// is refused here, before anything runs: an action that silently replaced
/// another would run the wrong code with nothing to say so.
/// </summary>
public sealed partial class Composite
{
    /// <summary>The prefix of PARAM_&lt;NAME&gt; and RECORD_PATH when no
    /// extension sets one.</summary>
    public const string DefaultEnvPrefix = "BDD_SUITE_";

    private const string TheCore = "the core";

    /// <summary>The core's own flags; an extension may not take one.</summary>
    public static readonly IReadOnlyList<string> CoreFlags =
    [
        "--path", "--tags", "--results", "--trace-file", "--schema-root", "--binding", "--format", "--param",
        "--json", "--strict", "--dry-run", "--binding-check",
    ];

    [GeneratedRegex("^--[a-z][a-z0-9-]*$")]
    private static partial Regex OptionPattern();

    private Composite(
        IReadOnlyList<IExtension> extensions, Dictionary<string, RegisteredAction> actions,
        List<string> contextKeys, List<ExtensionOption> options, string envPrefix)
    {
        Extensions = extensions;
        Actions = actions;
        ContextKeys = contextKeys;
        Roots = [.. Expression.CoreRoots, .. contextKeys];
        Options = options;
        EnvPrefix = envPrefix;
    }

    public IReadOnlyList<IExtension> Extensions { get; }

    /// <summary>Action name to its handler and owner, the core's
    /// included.</summary>
    public IReadOnlyDictionary<string, RegisteredAction> Actions { get; }

    /// <summary>The core roots and every extension's context keys: where a path
    /// may start.</summary>
    public IReadOnlyList<string> Roots { get; }

    /// <summary>Every extension's context keys, in declaration order.</summary>
    public IReadOnlyList<string> ContextKeys { get; }

    /// <summary>Every extension's options, in declaration order.</summary>
    public IReadOnlyList<ExtensionOption> Options { get; }

    public string EnvPrefix { get; }

    /// <summary>The core with no extension.</summary>
    public static Composite CoreOnly { get; } = Compose();

    /// <summary>Merge the core and the given extensions, refusing any name
    /// defined twice or taken from the core.</summary>
    public static Composite Compose(params IExtension[] extensions) => Compose((IEnumerable<IExtension>)extensions);

    /// <inheritdoc cref="Compose(IExtension[])"/>
    public static Composite Compose(IEnumerable<IExtension> extensions)
    {
        var list = extensions.ToList();
        var actions = new Dictionary<string, RegisteredAction>(StringComparer.Ordinal);
        foreach (var (name, handler) in CoreActions.Registry)
        {
            actions[name] = new RegisteredAction(handler, -1, TheCore);
        }
        actions["wait"] = new RegisteredAction(null, -1, TheCore);
        var keys = Expression.CoreRoots.ToDictionary(key => key, _ => TheCore, StringComparer.Ordinal);
        var flags = CoreFlags.ToDictionary(flag => flag, _ => TheCore, StringComparer.Ordinal);
        var contextKeys = new List<string>();
        var options = new List<ExtensionOption>();
        string? prefix = null;
        var prefixOwner = string.Empty;

        for (var index = 0; index < list.Count; index++)
        {
            var one = list[index];
            foreach (var registration in one.Actions)
            {
                if (actions.TryGetValue(registration.Name, out var held))
                {
                    throw Refuse($"Action {registration.Name} is defined by both {held.OwnerName} and {one.Name}.");
                }
                actions[registration.Name] = new RegisteredAction(registration.Handler, index, one.Name);
            }
            foreach (var key in one.ContextKeys)
            {
                if (keys.TryGetValue(key, out var owner))
                {
                    throw Refuse($"Context key {key} is defined by both {owner} and {one.Name}.");
                }
                keys[key] = one.Name;
                contextKeys.Add(key);
            }
            foreach (var option in one.Options)
            {
                if (!OptionPattern().IsMatch(option.Flag))
                {
                    throw Refuse($"{one.Name} declares the option {option.Flag}; an option is --lower-case-words.");
                }
                if (flags.TryGetValue(option.Flag, out var owner))
                {
                    throw Refuse($"Option {option.Flag} is defined by both {owner} and {one.Name}.");
                }
                flags[option.Flag] = one.Name;
                options.Add(option);
            }
            if (one.EnvPrefix is { } given)
            {
                if (prefix is not null && !string.Equals(prefix, given, StringComparison.Ordinal))
                {
                    throw Refuse($"{prefixOwner} sets the environment prefix {prefix} and {one.Name} sets {given}.");
                }
                prefix = given;
                prefixOwner = one.Name;
            }
        }
        return new Composite(list, actions, contextKeys, options, prefix ?? DefaultEnvPrefix);
    }

    private static ExtensionException Refuse(FormattableString message) =>
        new(message.ToString(CultureInfo.InvariantCulture));

    /// <summary>Every action this runtime runs, sorted: the core ones, wait,
    /// and every extension's.</summary>
    public List<string> Names()
    {
        var names = Actions.Keys.ToList();
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>Every extension's findings for one file.</summary>
    public List<Diagnostic> Lint(RuleInput input)
    {
        var found = new List<Diagnostic>();
        foreach (var one in Extensions)
        {
            if (one.Rules.Lint is { } lint)
            {
                found.AddRange(lint(input));
            }
        }
        return found;
    }

    /// <summary>The limit a case runs under: the smallest of what it declares
    /// and what every extension allows.</summary>
    public long CaseLimitSec(OrderedMap suite, long declaredSec)
    {
        var limit = declaredSec;
        foreach (var one in Extensions)
        {
            if (one.Rules.CaseLimitSec is { } allowed)
            {
                limit = Math.Min(limit, allowed(suite, declaredSec));
            }
        }
        return limit;
    }

    /// <summary>Start every extension with its own options' values, once per
    /// run.</summary>
    public StartedExtensions Start(IReadOnlyDictionary<string, string> values)
    {
        var states = new object?[Extensions.Count];
        // Only the values given: a declared key with none reads as '' unless the
        // suite's defaults name it (Executor.RunFile).
        var context = new Dictionary<string, object?>(StringComparer.Ordinal);
        var redactors = new List<Func<string, string>>();
        for (var index = 0; index < Extensions.Count; index++)
        {
            var one = Extensions[index];
            var own = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var option in one.Options)
            {
                if (values.TryGetValue(option.Flag, out var given))
                {
                    own[option.Flag] = given;
                }
            }
            var run = one.Start(own);
            states[index] = run.State;
            foreach (var key in one.ContextKeys)
            {
                if (run.Context is not null && run.Context.TryGetValue(key, out var value))
                {
                    context[key] = value;
                }
            }
            if (run.Redact is { } redact)
            {
                redactors.Add(redact);
            }
        }
        return new StartedExtensions(states, context, redactors);
    }
}

/// <summary>One run's started extensions: each one's state, the context
/// values, and one redaction over all of them.</summary>
public sealed class StartedExtensions(
    IReadOnlyList<object?> states, IReadOnlyDictionary<string, object?> context,
    IReadOnlyList<Func<string, string>> redactors)
{
    /// <summary>Nothing started: no state, no context, no redaction.</summary>
    public static StartedExtensions None { get; } = new([], new Dictionary<string, object?>(), []);

    /// <summary>The value each context key was given for this run.</summary>
    public IReadOnlyDictionary<string, object?> Context { get; } = context;

    /// <summary>The state of the extension that owns an action, or null for
    /// the core's.</summary>
    public object? State(int owner) => owner >= 0 && owner < states.Count ? states[owner] : null;

    /// <summary>A text passed through every extension's redaction, in
    /// order.</summary>
    public string Redact(string text) => redactors.Aggregate(text, (current, one) => one(current));
}

/// <summary>The extensions of one run, composed, and started with the run's
/// option values.</summary>
public sealed class RunExtensions(Composite composite, StartedExtensions started)
{
    public Composite Composite { get; } = composite;

    public StartedExtensions Started { get; } = started;

    /// <summary>The core alone: no extension, nothing started.</summary>
    public static RunExtensions CoreOnly { get; } = new(Composite.CoreOnly, StartedExtensions.None);
}
