using Microsoft.VisualStudio.TestTools.UnitTesting;

#if MODE_EOA
[assembly: ClassCleanupExecution(ClassCleanupBehavior.EndOfAssembly)]
#elif MODE_EOC
[assembly: ClassCleanupExecution(ClassCleanupBehavior.EndOfClass)]
#endif

namespace Q1;

[TestClass]
public class SuiteA
{
    [TestMethod] public void PassOne() { }
    [TestMethod] public void PassTwo() { }
#if CLASS_THROWS
    [ClassCleanup]
    public static void Teardown() => throw new InvalidOperationException("SUITE-A TEARDOWN FAILED");
#endif
}

[TestClass]
public class SuiteB
{
    [TestMethod] public void PassThree() { }
}

#if ASM_THROWS || ASM_EXIT
[TestClass]
public class AsmHooks
{
    [AssemblyCleanup]
    public static void AsmCleanup()
    {
#if ASM_EXIT
        Console.Error.WriteLine("RUN TEARDOWN FAILED (exiting 3)");
        Environment.Exit(3);
#else
        throw new InvalidOperationException("ASSEMBLY TEARDOWN FAILED");
#endif
    }
}
#endif

#if CTX_WRITE
[TestClass]
public class SuiteC
{
    [TestMethod] public void PassFour() { }
    [ClassCleanup]
    public static void Teardown(TestContext ctx)
    {
        ctx.WriteLine("CTX: suite C teardown note");
        Console.WriteLine("STDOUT: suite C teardown note");
        Console.Error.WriteLine("STDERR: suite C teardown note");
    }
}
[TestClass]
public class AsmCtx
{
    [AssemblyCleanup]
    public static void AsmCleanup(TestContext ctx)
    {
        ctx.WriteLine("CTX: assembly teardown note");
        Console.WriteLine("STDOUT: assembly teardown note");
    }
}
#endif
