using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.VisualStudio.TestTools.UnitTesting;

[assembly: Parallelize(Workers = 4, Scope = ExecutionScope.MethodLevel)]

namespace Q5;

static class Log
{
    static readonly Stopwatch Sw = Stopwatch.StartNew();
    static readonly ConcurrentQueue<string> Q = new();
    public static void W(string what, string test, object inst) =>
        Q.Enqueue($"{Sw.ElapsedMilliseconds,6} ms  tid={Environment.CurrentManagedThreadId,-3} inst={inst.GetHashCode():x8} {what,-16} {test}");
    public static void Flush() => File.WriteAllLines(Path.Combine(AppContext.BaseDirectory, "q5-log.txt"), Q);
}

[TestClass]
public class Suite
{
    public TestContext TestContext { get; set; } = null!;
    static int _active, _maxActiveInit;

    [ClassInitialize] public static void Setup(TestContext _) => Log.W("ClassInitialize", "-", typeof(Suite));
    [ClassCleanup] public static void Teardown() { Log.W("ClassCleanup", "-", typeof(Suite)); }
    [AssemblyCleanup] public static void Done() { Log.W($"maxConcurrentInit={_maxActiveInit}", "-", typeof(Suite)); Log.Flush(); }

    [TestInitialize]
    public void BeforeEach()
    {
        var n = Interlocked.Increment(ref _active);
        int m; while ((m = _maxActiveInit) < n && Interlocked.CompareExchange(ref _maxActiveInit, n, m) != m) { }
        Log.W("TestInit start", TestContext.TestName!, this);
        Thread.Sleep(200);
        Log.W("TestInit end", TestContext.TestName!, this);
        Interlocked.Decrement(ref _active);
    }

    [TestCleanup]
    public void AfterEach()
    {
        Log.W("TestCleanup start", TestContext.TestName!, this);
        Thread.Sleep(100);
        Log.W("TestCleanup end", TestContext.TestName!, this);
    }

    [TestMethod] public void A() => Thread.Sleep(300);
    [TestMethod] public void B() => Thread.Sleep(300);
    [TestMethod] public void C() => Thread.Sleep(300);
    [TestMethod] public void D() => Thread.Sleep(300);
    [TestMethod] public void E() => Thread.Sleep(300);
    [TestMethod] public void F() => Thread.Sleep(300);
}
