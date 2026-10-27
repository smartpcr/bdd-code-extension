using System.Globalization;
using Bdd.Suite.Model;

namespace Bdd.Suite.Tracing;

/// <summary>
/// Which step of which file one event is about (spec/events.md).
///
/// The trace names a step by its label, which two steps with one sentence, one
/// meta step used twice, or a sentence edited between runs all make ambiguous.
/// A reference is the address instead: <see cref="Id"/> is stable for one file
/// and one expansion whatever the sentence says, and <see cref="File"/> and
/// <see cref="Line"/> say where a reader finds the step.
/// </summary>
public sealed record StepRef
{
    /// <summary>The step's address: <c>&lt;list&gt;/&lt;index&gt;</c>, then
    /// <c>/&lt;meta&gt;/&lt;index&gt;</c> for each meta step it came through, then
    /// <c>/forStep</c> for each wait that polled it, then <c>#row&lt;n&gt;</c> for an
    /// examples row and <c>@table&lt;n&gt;</c> for a table row. Indices count from
    /// zero; the list is one of suiteSetup, beforeEach, setup, steps, cleanup,
    /// afterEach, teardown.</summary>
    public required string Id { get; init; }

    /// <summary>The trace's phase (<see cref="Tracing.Phase"/>).</summary>
    public required string Phase { get; init; }

    public string Suite { get; init; } = string.Empty;

    /// <summary>The case the step ran for, as the report names it; empty for the
    /// suite's setup and teardown.</summary>
    public string Case { get; init; } = string.Empty;

    /// <summary>The examples row of the case, from zero; -1 for none.</summary>
    public int ExamplesRow { get; init; } = -1;

    /// <summary>The table row of the step, from zero; -1 for none.</summary>
    public int TableRow { get; init; } = -1;

    public string Keyword { get; init; } = string.Empty;
    public string Sentence { get; init; } = string.Empty;
    public string Action { get; init; } = string.Empty;

    /// <summary>What the trace calls the same step, so a reader can join the
    /// two.</summary>
    public string Label { get; init; } = string.Empty;

    /// <summary>The file the step is written in, as the runner opened it: the
    /// suite, or the library a meta step was imported from.</summary>
    public string File { get; init; } = string.Empty;

    /// <summary>Where the step begins in <see cref="File"/>, one-based; zero when
    /// unknown.</summary>
    public int Line { get; init; }

    public int Column { get; init; }

    /// <summary>An address with the rows it ran for (-1 for none).</summary>
    public static string IdOf(string address, int examplesRow, int tableRow)
    {
        var id = address;
        if (examplesRow >= 0)
        {
            id += string.Create(CultureInfo.InvariantCulture, $"#row{examplesRow}");
        }
        if (tableRow >= 0)
        {
            id += string.Create(CultureInfo.InvariantCulture, $"@table{tableRow}");
        }
        return id;
    }

    /// <summary>The reference as spec/events.md writes it.</summary>
    public OrderedMap ToMap()
    {
        var out_ = new OrderedMap();
        out_.Set("id", Id);
        out_.Set("phase", Phase);
        if (Case.Length > 0)
        {
            out_.Set("case", Case);
        }
        if (ExamplesRow >= 0)
        {
            out_.Set("examplesRow", (long)ExamplesRow);
        }
        if (TableRow >= 0)
        {
            out_.Set("tableRow", (long)TableRow);
        }
        if (Keyword.Length > 0)
        {
            out_.Set("keyword", Keyword);
        }
        if (Sentence.Length > 0)
        {
            out_.Set("sentence", Sentence);
        }
        if (Action.Length > 0)
        {
            out_.Set("action", Action);
        }
        out_.Set("label", Label);
        if (File.Length > 0)
        {
            out_.Set("file", File);
        }
        if (Line > 0)
        {
            out_.Set("line", (long)Line);
            out_.Set("column", (long)Column);
        }
        return out_;
    }
}
