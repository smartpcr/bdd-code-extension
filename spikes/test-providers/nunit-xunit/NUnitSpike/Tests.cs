using NUnit.Framework;

// Q4: run-wide hook. No namespace => applies to every fixture in the assembly.
[SetUpFixture]
public class RunHooks
{
    [OneTimeSetUp] public void RunSetUp() => Log.W("RUN OneTimeSetUp");
    [OneTimeTearDown] public void RunTearDown()
    {
        Log.W("RUN OneTimeTearDown");
        if (Environment.GetEnvironmentVariable("SPIKE_RUN_TEARDOWN_THROW") == "1")
            throw new InvalidOperationException("run teardown boom");
    }
}

namespace Spike
{
    // Q1: two passing tests, suite teardown throws.
    [TestFixture]
    public class Q1_TeardownFails
    {
        [OneTimeSetUp] public void Ots() => Log.W("Q1 OneTimeSetUp");
        [Test] public void PassA() => Log.W("Q1 PassA");
        [Test] public void PassB() => Log.W("Q1 PassB");
        [OneTimeTearDown] public void Ott() { Log.W("Q1 OneTimeTearDown"); throw new InvalidOperationException("suite teardown boom"); }
    }

    // Q2: exact display names and categories.
    [TestFixture]
    public class Q2_Naming
    {
        [TestCase(TestName = "places an order", Category = "smoke")]
        public void Case1() => Log.W("Q2 places an order");

        [TestCase("rejects [qty=0]", TestName = "rejects [qty=0]")]
        [Category("slow")]
        public void Case2(string name) => Log.W("Q2 " + name);

        // examples rows: one test per row, each with its own exact name
        [TestCase("row 1", TestName = "adds items <a=1, b=2>")]
        [TestCase("row 2", TestName = "adds items <a=3, b=4>", Category = "smoke")]
        public void Outline(string row) => Log.W("Q2 outline " + row);

        [Test, Category("smoke")] public void PlainTest() => Log.W("Q2 plain");
    }

    // Q3a: SetUp throws -> does TearDown run?
    [TestFixture]
    public class Q3_SetUpThrows
    {
        [SetUp] public void Su() { Log.W("Q3a SetUp (throws)"); throw new InvalidOperationException("setup boom"); }
        [TearDown] public void Td() => Log.W("Q3a TearDown");
        [Test] public void T1() => Log.W("Q3a T1 body");
    }

    // Q3b: OneTimeSetUp throws -> tests? OneTimeTearDown?
    [TestFixture]
    public class Q3_OneTimeSetUpThrows
    {
        [OneTimeSetUp] public void Ots() { Log.W("Q3b OneTimeSetUp (throws)"); throw new InvalidOperationException("suite setup boom"); }
        [SetUp] public void Su() => Log.W("Q3b SetUp");
        [TearDown] public void Td() => Log.W("Q3b TearDown");
        [Test] public void T1() => Log.W("Q3b T1 body");
        [Test] public void T2() => Log.W("Q3b T2 body");
        [OneTimeTearDown] public void Ott() => Log.W("Q3b OneTimeTearDown");
    }

    // Q4: runtime ignore.
    [TestFixture]
    public class Q4_Ignore
    {
        [Test] public void Skipped() { Log.W("Q4 Skipped body"); Assert.Ignore("not on this platform"); }
        [Test] public void Inconclusive() { Assert.Inconclusive("pending step"); }
        [Test] public void Pass() => Log.W("Q4 Pass");
    }
}
