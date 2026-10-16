using Bdd.Suite.Run;
using Shop.Suite;

// The sample workspace's suiterun, C# binding: the runtime's command line with
// this workspace's extension.
return Runner.Run(args, Console.Out, Console.Error, new ShopExtension());
