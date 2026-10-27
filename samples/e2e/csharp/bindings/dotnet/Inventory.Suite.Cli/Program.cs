using Bdd.Suite.Run;
using Inventory.Suite;

// One command line, one exit code: the runtime's suiterun with the inventory
// extension. Lint, list, actions and --dry-run run no action.
return Runner.Run(args, Console.Out, Console.Error, new InventoryExtension());
