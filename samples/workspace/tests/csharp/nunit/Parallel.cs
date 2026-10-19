// NUnit's most parallel setting (docs/test-providers, E11): fixtures and the
// tests inside them run in parallel on four workers. Cases of one suite still
// never overlap: the session's case lock serialises them (spec/session.md,
// rule 7).
[assembly: NUnit.Framework.Parallelizable(NUnit.Framework.ParallelScope.Fixtures | NUnit.Framework.ParallelScope.Children)]
[assembly: NUnit.Framework.LevelOfParallelism(4)]
