using System.Globalization;
using Bdd.Suite.Model;

namespace Bdd.Suite.Walking;

/// <summary>One step, with where it is written and when it runs.</summary>
public sealed class StepEntry
{
    public required OrderedMap Step { get; init; }
    public required string Pointer { get; init; }
    public required string Phase { get; init; }

    /// <summary>Ten per step, so a nested step can sit just before the one that
    /// drives it. The dataflow pass compares these to decide whether a capture
    /// exists yet.</summary>
    public long Order { get; set; }
}

/// <summary>One list of steps, with what to call it in a message.</summary>
public sealed class StepList
{
    public required List<object?> Steps { get; init; }
    public required string Pointer { get; init; }
    public required string Name { get; init; }
    public OrderedMap? Case { get; init; }
    public int CaseIndex { get; init; } = -1;
}

/// <summary>
/// Where the steps are.
///
/// Two views of the same file, because two passes need different ones. The
/// structural pass wants every step once, flattened, with its pointer. The
/// Gherkin rules are per list - a case's steps are one scenario and its cleanup
/// is not part of it - so that pass wants the lists.
/// </summary>
public static class Walk
{
    /// <summary>The four suite-level step lists, in the order they run.</summary>
    public static readonly string[] Hooks = ["setup", "beforeEach", "afterEach", "teardown"];

    /// <summary>The three step lists one case owns.</summary>
    public static readonly string[] CasePhases = ["setup", "steps", "cleanup"];

    /// <summary>Flatten one list into an entry per step, nested steps
    /// included.</summary>
    public static List<StepEntry> StepEntries(List<object?>? list, string pointer, string phase)
    {
        var entries = new List<StepEntry>();
        if (list is null)
        {
            return entries;
        }
        for (var index = 0; index < list.Count; index++)
        {
            if (list[index] is not OrderedMap step)
            {
                continue;
            }
            var order = index * 10L;
            var stepPointer = string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}");
            // A `wait` runs a nested step and publishes its capture just before
            // polling it, so the nested one is ordered one ahead of its parent.
            if (step.Value("forStep") is OrderedMap nested)
            {
                entries.Add(new StepEntry
                {
                    Step = nested,
                    Pointer = stepPointer + "/forStep",
                    Phase = phase,
                    Order = order - 1,
                });
            }
            entries.Add(new StepEntry { Step = step, Pointer = stepPointer, Phase = phase, Order = order });
        }
        return entries;
    }

    /// <summary>Every step in the file, once.</summary>
    public static List<StepEntry> AllSteps(OrderedMap? suite)
    {
        var entries = new List<StepEntry>();
        if (suite is null)
        {
            return entries;
        }
        foreach (var hook in Hooks)
        {
            entries.AddRange(StepEntries(suite.List(hook), "/" + hook, hook));
        }
        var metas = suite.List("metaSteps");
        if (metas is not null)
        {
            for (var index = 0; index < metas.Count; index++)
            {
                if (metas[index] is not OrderedMap meta)
                {
                    continue;
                }
                entries.AddRange(StepEntries(
                    meta.List("steps"),
                    string.Create(CultureInfo.InvariantCulture, $"/metaSteps/{index}/steps"),
                    "meta " + meta.Text("name")));
            }
        }
        var cases = suite.List("tests");
        if (cases is not null)
        {
            for (var index = 0; index < cases.Count; index++)
            {
                if (cases[index] is not OrderedMap held)
                {
                    continue;
                }
                foreach (var phase in CasePhases)
                {
                    entries.AddRange(StepEntries(
                        held.List(phase),
                        string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/{phase}"),
                        phase));
                }
            }
        }
        return entries;
    }

    /// <summary>Every list of steps in the file, with a name a message can
    /// use.</summary>
    public static List<StepList> StepLists(OrderedMap? suite)
    {
        var lists = new List<StepList>();
        if (suite is null)
        {
            return lists;
        }
        foreach (var hook in Hooks)
        {
            if (suite.List(hook) is { } steps)
            {
                lists.Add(new StepList { Steps = steps, Pointer = "/" + hook, Name = "the suite " + hook });
            }
        }
        var metas = suite.List("metaSteps");
        if (metas is not null)
        {
            for (var index = 0; index < metas.Count; index++)
            {
                if (metas[index] is not OrderedMap meta || meta.List("steps") is not { } steps)
                {
                    continue;
                }
                lists.Add(new StepList
                {
                    Steps = steps,
                    Pointer = string.Create(CultureInfo.InvariantCulture, $"/metaSteps/{index}/steps"),
                    Name = "meta step " + meta.Text("name"),
                });
            }
        }
        var cases = suite.List("tests");
        if (cases is not null)
        {
            for (var index = 0; index < cases.Count; index++)
            {
                if (cases[index] is not OrderedMap held)
                {
                    continue;
                }
                foreach (var phase in CasePhases)
                {
                    if (held.List(phase) is not { } steps)
                    {
                        continue;
                    }
                    lists.Add(new StepList
                    {
                        Steps = steps,
                        Pointer = string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/{phase}"),
                        Name = string.Create(CultureInfo.InvariantCulture, $"case {held.Text("name")} {phase}"),
                        Case = held,
                        CaseIndex = index,
                    });
                }
            }
        }
        return lists;
    }

    /// <summary>The columns a table declares, which is what its first row
    /// holds.</summary>
    public static List<string> TableColumns(object? table)
    {
        if (table is not List<object?> rows)
        {
            return [];
        }
        foreach (var row in rows)
        {
            if (row is OrderedMap held)
            {
                return [.. held.Keys];
            }
        }
        return [];
    }

    /// <summary>Every entry of a list that is an object, blanks skipped but
    /// their index kept.</summary>
    public static List<OrderedMap?> Entries(OrderedMap? held, string key)
    {
        var out_ = new List<OrderedMap?>();
        foreach (var raw in held?.List(key) ?? [])
        {
            out_.Add(raw as OrderedMap);
        }
        return out_;
    }
}
