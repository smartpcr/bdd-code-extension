using Bdd.Suite.Run;

// One command line, one exit code. Everything else is in the library, so the
// tests drive the same path this does. This is the plain runtime: no
// extension. A consumer's own suiterun is this one line with its extensions
// passed after the two writers (DEC-S03).
// UTF-8 whatever the console's code page: a test plan carries case names as
// they are written (spec/test-plan.md).
Console.OutputEncoding = new System.Text.UTF8Encoding(false);
return Runner.Run(args, Console.Out, Console.Error);
