// suiterun with the corpus's extension (its context keys), as the corpus tests
// spawn it: exactly what a consumer's own suiterun is, built from the runtime
// and its extensions.
import { main } from '../../src/cli.js';
import { corpusExtension } from '../where.js';

process.exitCode = await main(process.argv.slice(2), undefined, [corpusExtension]);
