using Bdd.Suite.Example;
using Bdd.Suite.Run;

// The example workspace's own suiterun: the runtime's command line with the
// example extension, which is all a consumer's suiterun is.
return Runner.Run(args, Console.Out, Console.Error, new EchoExtension());
