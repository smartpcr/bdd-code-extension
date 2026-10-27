using Bdd.Suite.Run;
using {{Namespace}}.Suite;

// One command line, one exit code: the runtime's suiterun with the {{name}}
// extension. Lint, list, actions and --dry-run run no action.
return Runner.Run(args, Console.Out, Console.Error, new {{Namespace}}Extension());
