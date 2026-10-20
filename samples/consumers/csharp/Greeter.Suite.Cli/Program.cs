using Bdd.Suite.Run;
using Greeter.Suite;

// The greeter's suiterun: lint, run and list its suites with its extension.
return Runner.Run(args, Console.Out, Console.Error, new GreeterExtension());
