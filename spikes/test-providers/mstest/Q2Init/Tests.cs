using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Q2;

static class Log
{
    static readonly string P = Path.Combine(AppContext.BaseDirectory, "q2-log.txt");
    static readonly object L = new();
    public static void W(string s) { lock (L) File.AppendAllText(P, s + Environment.NewLine); }
}

[TestClass]
public class InitThrows
{
    [TestInitialize] public void Before() { Log.W("InitThrows.TestInitialize (throwing)"); throw new InvalidOperationException("BEFORE-EACH FAILED"); }
    [TestMethod] public void Body() { Log.W("InitThrows.Body RAN"); }
    [TestCleanup] public void After() { Log.W("InitThrows.TestCleanup RAN"); }
}

[TestClass]
public class ClassInitThrows
{
    [ClassInitialize] public static void Setup(TestContext _) { Log.W("ClassInitThrows.ClassInitialize (throwing)"); throw new InvalidOperationException("SUITE SETUP FAILED"); }
    [TestInitialize] public void Before() { Log.W("ClassInitThrows.TestInitialize RAN"); }
    [TestMethod] public void First() { Log.W("ClassInitThrows.First RAN"); }
    [TestMethod] public void Second() { Log.W("ClassInitThrows.Second RAN"); }
    [TestCleanup] public void After() { Log.W("ClassInitThrows.TestCleanup RAN"); }
    [ClassCleanup] public static void Teardown() { Log.W("ClassInitThrows.ClassCleanup RAN"); }
}
