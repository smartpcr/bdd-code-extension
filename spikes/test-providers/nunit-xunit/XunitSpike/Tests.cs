using Xunit;

// Q5b: run-wide hook via assembly fixture; throws on dispose when SPIKE_ASM_THROW=1.
[assembly: AssemblyFixture(typeof(Spike.RunFixture))]

namespace Spike
{
    public sealed class RunFixture : IAsyncLifetime
    {
        public ValueTask InitializeAsync() { Log.W("RUN InitializeAsync"); return default; }
        public ValueTask DisposeAsync()
        {
            Log.W("RUN DisposeAsync");
            if (Environment.GetEnvironmentVariable("SPIKE_ASM_THROW") == "1")
                throw new InvalidOperationException("run teardown boom");
            return default;
        }
    }

    // Q5a: suite fixture whose teardown throws.
    public sealed class Q5Fixture : IAsyncLifetime
    {
        public ValueTask InitializeAsync() { Log.W("Q5 suite InitializeAsync"); return default; }
        public ValueTask DisposeAsync() { Log.W("Q5 suite DisposeAsync (throws)"); throw new InvalidOperationException("suite teardown boom"); }
    }

    public class Q5_TeardownFails : IClassFixture<Q5Fixture>
    {
        public Q5_TeardownFails(Q5Fixture f, RunFixture r) { }
        [Fact] public void PassA() => Log.W("Q5 PassA");
        [Fact] public void PassB() => Log.W("Q5 PassB");
    }

    // Q6: ctor (beforeEach) throws; is Dispose (afterEach) called?
    public class Q6_CtorThrowsDisposable : IDisposable
    {
        public Q6_CtorThrowsDisposable() { Log.W("Q6a ctor (throws)"); throw new InvalidOperationException("beforeEach boom"); }
        [Fact] public void T1() => Log.W("Q6a T1 body");
        public void Dispose() => Log.W("Q6a Dispose");
    }

    public class Q6_CtorThrowsAsyncDisposable : IAsyncDisposable
    {
        public Q6_CtorThrowsAsyncDisposable() { Log.W("Q6b ctor (throws)"); throw new InvalidOperationException("beforeEach boom"); }
        [Fact] public void T1() => Log.W("Q6b T1 body");
        public ValueTask DisposeAsync() { Log.W("Q6b DisposeAsync"); return default; }
    }

    // Q6c: IAsyncLifetime on the test class: InitializeAsync throws -> DisposeAsync?
    public class Q6_InitThrowsAsyncLifetime : IAsyncLifetime
    {
        public ValueTask InitializeAsync() { Log.W("Q6c InitializeAsync (throws)"); throw new InvalidOperationException("beforeEach boom"); }
        [Fact] public void T1() => Log.W("Q6c T1 body");
        public ValueTask DisposeAsync() { Log.W("Q6c DisposeAsync"); return default; }
    }

    // Q6d: normal order, ctor -> body -> dispose, failing body.
    public class Q6_Normal : IAsyncLifetime
    {
        public Q6_Normal() => Log.W("Q6d ctor");
        public ValueTask InitializeAsync() { Log.W("Q6d InitializeAsync"); return default; }
        [Fact] public void Fails() { Log.W("Q6d body (fails)"); Assert.Fail("body boom"); }
        public ValueTask DisposeAsync() { Log.W("Q6d DisposeAsync"); return default; }
    }

    // Q7: names and traits.
    public class Q7_Naming
    {
        [Fact(DisplayName = "places an order")]
        [Trait("Category", "smoke")]
        public void Case1() => Log.W("Q7 places an order");

        [Theory(DisplayName = "rejects")]
        [InlineData("rejects [qty=0]", TestDisplayName = "rejects [qty=0]", Traits = new[] { "Category", "slow" })]
        [InlineData("rejects [qty=-1]", TestDisplayName = "rejects [qty=-1]")]
        public void Case2(string name) => Log.W("Q7 " + name);

        public static IEnumerable<TheoryDataRow<int, int>> Rows() =>
        [
            new TheoryDataRow<int, int>(1, 2) { TestDisplayName = "adds items <a=1, b=2>" },
            new TheoryDataRow<int, int>(3, 4) { TestDisplayName = "adds items <a=3, b=4>", Traits = new() { ["Category"] = new() { "smoke" } } },
        ];

        [Theory, MemberData(nameof(Rows))]
        public void Outline(int a, int b) => Log.W($"Q7 outline {a},{b}");

        [Fact] public void PlainTest() => Log.W("Q7 plain");
    }

    // Q8: runtime skip.
    public class Q8_Skip
    {
        [Fact] public void Skipped() { Log.W("Q8 Skipped body"); Assert.Skip("not on this platform"); }
        [Fact] public void Pass() => Log.W("Q8 Pass");
    }

    // Q9: parallelism within a class and across classes.
    public class Q9_ParA
    {
        [Fact] public async Task A1() { Log.W("Q9 A1 start"); await Task.Delay(1000); Log.W("Q9 A1 end"); }
        [Fact] public async Task A2() { Log.W("Q9 A2 start"); await Task.Delay(1000); Log.W("Q9 A2 end"); }
    }
    public class Q9_ParB
    {
        [Fact] public async Task B1() { Log.W("Q9 B1 start"); await Task.Delay(1000); Log.W("Q9 B1 end"); }
    }
}

namespace Spike
{
    // Q7b: one [Fact] per examples row gives exact names (no argument suffix).
    public class Q7b_RowsAsFacts
    {
        [Fact(DisplayName = "rejects [qty=0]")] public void Rejects_row1() => Run("qty=0");
        [Fact(DisplayName = "adds items <a=1, b=2> (x)")] public void Adds_row1() => Run("a=1");
        static void Run(string r) => Log.W("Q7b " + r);
    }
}
