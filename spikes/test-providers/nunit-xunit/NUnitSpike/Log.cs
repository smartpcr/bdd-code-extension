// Event log shared by all spike fixtures: one line per hook/test, appended to SPIKE_LOG (or bin/events.log).
public static class Log
{
    static readonly object Gate = new();
    public static string PathName => Environment.GetEnvironmentVariable("SPIKE_LOG")
        ?? System.IO.Path.Combine(AppContext.BaseDirectory, "events.log");
    public static void W(string msg)
    {
        lock (Gate) File.AppendAllText(PathName, $"{DateTime.Now:HH:mm:ss.fff} [{Environment.CurrentManagedThreadId}] {msg}{Environment.NewLine}");
    }
}
