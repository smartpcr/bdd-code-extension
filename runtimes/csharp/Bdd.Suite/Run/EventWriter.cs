using System.Text;
using System.Text.Json;
using Bdd.Suite.Execution;
using Bdd.Suite.Model;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Run;

/// <summary>
/// `run --events &lt;file&gt;`: what the run does, as it does it, one JSON object per
/// line (spec/events.md). A host that shows a run live, or keeps its history,
/// reads this file while it grows; every line is flushed as it is written.
///
/// Every text passes through the extensions' redaction, as the report's do. A
/// captured value or a failure's detail longer than <see cref="ValueLimit"/>
/// characters is written as a truncated preview with <c>valueTruncated</c>; the
/// report still carries the whole value.
/// </summary>
public sealed class EventWriter : IRunObserver, IStepObserver, IDisposable
{
    /// <summary>The longest value, as JSON text, written whole.</summary>
    public const int ValueLimit = 8192;

    /// <summary>The format's version, on <c>runStarted</c>.</summary>
    public const int FormatVersion = 1;

    private readonly StreamWriter _out;
    private readonly Func<string, string> _redact;
    private readonly object _gate = new();
    private bool _disposed;

    /// <summary>Write to <paramref name="path"/>, replacing it; open for reading
    /// by others while it is written.</summary>
    public EventWriter(string path, Func<string, string>? redact = null)
    {
        var parent = Path.GetDirectoryName(Path.GetFullPath(path));
        if (parent is not null)
        {
            Directory.CreateDirectory(parent);
        }
        var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        _out = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        _redact = redact ?? (text => text);
    }

    public void RunStarted(IReadOnlyList<string> files) => Write("runStarted", writer =>
    {
        writer.WriteNumber("version", FormatVersion);
        writer.WriteStartArray("files");
        foreach (var file in files)
        {
            writer.WriteStringValue(file);
        }
        writer.WriteEndArray();
    });

    public void SuiteStarted(string file, string suite) => Write("suiteStarted", writer =>
    {
        writer.WriteString("suite", suite);
        writer.WriteString("file", file);
    });

    public void SuiteFinished(string file, string suite) => Write("suiteFinished", writer =>
    {
        writer.WriteString("suite", suite);
        writer.WriteString("file", file);
    });

    /// <summary>The last line: passed, failed or cancelled, and the exit code the
    /// process is about to return.</summary>
    public void RunFinished(string status, int exitCode) => Write("runFinished", writer =>
    {
        writer.WriteString("status", status);
        writer.WriteNumber("exitCode", exitCode);
    });

    public void CaseStarted(string suite, string caseName) => Write("caseStarted", writer =>
    {
        writer.WriteString("suite", suite);
        writer.WriteString("case", _redact(caseName));
    });

    public void CaseFinished(string suite, CaseResult result) => Write("caseFinished", writer =>
    {
        writer.WriteString("suite", suite);
        writer.WriteString("case", _redact(result.Name));
        writer.WriteString("status", result.Status);
        if (result.Reason.Length > 0)
        {
            writer.WriteString("reason", result.Reason);
        }
        writer.WriteNumber("durationMs", (long)Math.Round(result.DurationSec * 1000));
        if (result.Message.Length > 0)
        {
            writer.WriteString("message", _redact(result.Message));
        }
        if (result.AfterEachFailed)
        {
            writer.WriteBoolean("afterEachFailed", true);
        }
    });

    /// <summary>Trace entries are the trace's; the step events say more.</summary>
    public void Entry(TraceEntry entry)
    {
    }

    public void StepStarted(StepRef step, DateTimeOffset at) => Write("stepStarted", writer =>
    {
        writer.WriteString("suite", step.Suite);
        WriteValue(writer, "step", step.ToMap(), truncate: false);
    }, at);

    public void StepFinished(StepResult result) => Write("stepFinished", writer =>
    {
        writer.WriteString("suite", result.Step.Suite);
        WriteValue(writer, "step", result.Step.ToMap(), truncate: false);
        writer.WriteString("status", result.Status);
        if (result.Reason.Length > 0)
        {
            writer.WriteString("reason", result.Reason);
        }
        writer.WriteString("started", result.Started.UtcDateTime.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        writer.WriteNumber("durationMs", (long)Math.Round((result.Finished - result.Started).TotalMilliseconds));
        if (result.Message.Length > 0)
        {
            writer.WriteString("message", _redact(result.Message));
        }
        if (result.Detail is not null)
        {
            WriteValue(writer, "detail", result.Detail, truncate: true);
        }
        if (result.Returned)
        {
            WriteValue(writer, "value", result.Value, truncate: true);
        }
        if (result.Asserts.Count > 0)
        {
            writer.WriteStartArray("asserts");
            foreach (var one in result.Asserts)
            {
                writer.WriteStartObject();
                writer.WriteString("var", one.Var);
                writer.WriteString("operator", one.Operator);
                WriteValue(writer, "expected", one.Expected, truncate: true);
                if (one.Present)
                {
                    WriteValue(writer, "actual", one.Actual, truncate: true);
                }
                writer.WriteBoolean("present", one.Present);
                writer.WriteBoolean("holds", one.Holds);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
    }, result.Finished);

    public void Note(StepRef step, string text, DateTimeOffset at) => Write("note", writer =>
    {
        writer.WriteString("suite", step.Suite);
        writer.WriteString("stepId", step.Id);
        if (step.Case.Length > 0)
        {
            writer.WriteString("case", _redact(step.Case));
        }
        writer.WriteString("text", _redact(text));
    }, at);

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            _out.Dispose();
        }
    }

    /// <summary>One line: the event's name and time, then its own fields.</summary>
    private void Write(string name, Action<Utf8JsonWriter> fields, DateTimeOffset? at = null)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("event", name);
            writer.WriteString("at", (at ?? DateTimeOffset.UtcNow).UtcDateTime.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
            fields(writer);
            writer.WriteEndObject();
        }
        var line = Encoding.UTF8.GetString(buffer.ToArray());
        lock (_gate)
        {
            if (!_disposed)
            {
                _out.WriteLine(line);
            }
        }
    }

    /// <summary>A value as JSON, redacted. Redaction works on text; a value whose
    /// redacted text is no longer JSON is written as that text, a string.</summary>
    private void WriteValue(Utf8JsonWriter writer, string property, object? value, bool truncate)
    {
        string json;
        try
        {
            var text = new StringBuilder();
            OrderedMap.WriteJson(value, text);
            json = text.ToString();
        }
        catch (Exception failure) when (failure is NotSupportedException or JsonException or InvalidOperationException)
        {
            json = JsonSerializer.Serialize(value?.ToString() ?? string.Empty);
        }
        var redacted = _redact(json);
        if (truncate && redacted.Length > ValueLimit)
        {
            writer.WriteString(property + "Preview", redacted[..ValueLimit]);
            writer.WriteBoolean(property + "Truncated", true);
            return;
        }
        if (IsJson(redacted))
        {
            writer.WritePropertyName(property);
            writer.WriteRawValue(redacted, skipInputValidation: true);
            return;
        }
        writer.WriteString(property, redacted);
    }

    private static bool IsJson(string text)
    {
        try
        {
            using var _ = JsonDocument.Parse(text);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}

/// <summary>Several observers as one: what `run` hands the executor when both
/// <c>--progress</c> and <c>--events</c> are given. Each hears what it
/// implements.</summary>
internal sealed class Observers(IReadOnlyList<IRunObserver> observers) : IRunObserver, IStepObserver
{
    public void CaseStarted(string suite, string caseName)
    {
        foreach (var one in observers)
        {
            one.CaseStarted(suite, caseName);
        }
    }

    public void CaseFinished(string suite, CaseResult result)
    {
        foreach (var one in observers)
        {
            one.CaseFinished(suite, result);
        }
    }

    public void Entry(TraceEntry entry)
    {
        foreach (var one in observers)
        {
            one.Entry(entry);
        }
    }

    public void StepStarted(StepRef step, DateTimeOffset at)
    {
        foreach (var one in observers.OfType<IStepObserver>())
        {
            one.StepStarted(step, at);
        }
    }

    public void StepFinished(StepResult result)
    {
        foreach (var one in observers.OfType<IStepObserver>())
        {
            one.StepFinished(result);
        }
    }

    public void Note(StepRef step, string text, DateTimeOffset at)
    {
        foreach (var one in observers.OfType<IStepObserver>())
        {
            one.Note(step, text, at);
        }
    }
}
