Throw-away spike: Jest 30.5.2 / Vitest 5.0.4 / node:test (Node 24.16.0) behaviour for generated BDD suites.
Run from this folder:
  npx jest <path> [-t pattern] [-i|--maxWorkers=N]        (config: jest.config.js, jest-junit -> out/)
  npx vitest run <path> --reporter=verbose --reporter=junit --outputFile.junit=out/x.xml
  npx vitest run -c vitest.projects.config.mjs --project serial|shared
  node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=out/x.xml nodetest/<file>
  node --test --test-reporter=./nodetest/events-reporter.mjs nodetest/<file>
