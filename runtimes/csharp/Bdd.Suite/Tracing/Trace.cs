using Bdd.Suite.Model;

namespace Bdd.Suite.Tracing;

/// <summary>Where in the run one entry happened.</summary>
public static class Phase
{
    public const string SuiteSetup = "suite-setup";
    public const string BeforeEach = "before-each";
    public const string CaseSetup = "case-setup";
    public const string Step = "step";
    public const string CaseCleanup = "case-cleanup";
    public const string AfterEach = "after-each";
    public const string SuiteTeardown = "suite-teardown";
    public const string Case = "case";
}

/// <summary>What happened.</summary>
public static class Status
{
    public const string Passed = "passed";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
    public const string Error = "error";
}

/// <summary>Why, for anything that is not passed. A closed list, so four
/// bindings categorise a failure the same way.</summary>
public static class Reason
{
    public const string Assertion = "assertion";
    public const string Timeout = "timeout";
    public const string Action = "action";
    public const string Hook = "hook";
    public const string Cleanup = "cleanup";
    public const string SuiteSetup = "suite-setup";
    public const string Tag = "tag";
    public const string Guard = "guard";

    /// <summary>A case that skipped itself: an action in its setup or steps
    /// found the environment cannot run it (spec/session.md rule 12).</summary>
    public const string Skip = "skip";

    /// <summary>Work the run was asked to stop (spec/events.md, "Cancel"): the
    /// step running when the cancel came, and every case not yet started.
    /// Cleanup, afterEach and teardown are never cancelled.</summary>
    public const string Cancelled = "cancelled";

    /// <summary>The absence of a reason, which a passed entry carries.</summary>
    public const string None = "";
}

/// <summary>One thing the run did.</summary>
public sealed record TraceEntry(
    string Phase, string Case, string Step, string Action, string Status, string Reason)
{
    /// <summary>One entry as the trace schema defines it.</summary>
    public OrderedMap ToMap()
    {
        var out_ = new OrderedMap();
        out_.Set("phase", Phase);
        if (Case.Length > 0)
        {
            out_.Set("case", Case);
        }
        if (Step.Length > 0)
        {
            out_.Set("step", Step);
        }
        if (Action.Length > 0)
        {
            out_.Set("action", Action);
        }
        out_.Set("status", Status);
        if (Reason.Length > 0)
        {
            out_.Set("reason", Reason);
        }
        return out_;
    }
}

/// <summary>
/// What the run did, in the order it did it.
///
/// Y3.3. A report says which cases passed; a trace says in which order the
/// phases ran, which step a guard skipped, which row of a table failed and why.
/// It holds no durations and no messages, because a trace two bindings compare
/// cannot carry a number that differs by hardware or a sentence they are free to
/// word differently.
/// </summary>
public sealed class Trace
{
    // Sessions of one run context may run on different threads (a test
    // framework running suites in parallel), so every access is under a lock.
    private readonly List<TraceEntry> _entries = [];
    private readonly object _gate = new();

    /// <summary>The entries so far, as a copy.</summary>
    public IReadOnlyList<TraceEntry> Entries
    {
        get
        {
            lock (_gate)
            {
                return [.. _entries];
            }
        }
    }

    /// <summary>Called with each entry as it is recorded, for a run observer
    /// (spec/progress.md). It sees the entry; it does not change what is recorded.</summary>
    public Action<TraceEntry>? Added { get; set; }

    /// <summary>Record one thing the run did. An empty name is no name.</summary>
    public void Add(string phase, string caseName, string step, string action, string status, string reason)
    {
        var entry = new TraceEntry(phase, caseName, step, action, status, reason);
        lock (_gate)
        {
            _entries.Add(entry);
        }
        // Outside the lock, so a slow observer never holds the trace.
        Added?.Invoke(entry);
    }

    /// <summary>An array even when the run did one thing, and empty rather than
    /// absent when it did none.</summary>
    public List<object?> ToList() => Entries.Select(entry => (object?)entry.ToMap()).ToList();

    /// <summary>The document `--trace-file` holds, indented the way every
    /// binding writes it.</summary>
    public string ToJson()
    {
        var entries = Entries;
        if (entries.Count == 0)
        {
            return "[]";
        }
        var built = new System.Text.StringBuilder("[\n");
        for (var index = 0; index < entries.Count; index++)
        {
            var map = entries[index].ToMap();
            built.Append("  {\n");
            for (var key = 0; key < map.Keys.Count; key++)
            {
                built.Append("    ");
                built.Append(System.Text.Json.JsonSerializer.Serialize(map.Keys[key]));
                built.Append(": ");
                built.Append(System.Text.Json.JsonSerializer.Serialize(map.Value(map.Keys[key]) as string));
                built.Append(key + 1 < map.Keys.Count ? ",\n" : "\n");
            }
            built.Append("  }");
            built.Append(index + 1 < entries.Count ? ",\n" : "\n");
        }
        built.Append(']');
        return built.ToString();
    }
}
