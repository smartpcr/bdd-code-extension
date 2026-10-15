#!/usr/bin/env node
// The example workspace's own suiterun: the runtime's command line with the
// example extension, which is all a consumer's suiterun is.
import { main } from '../../src/cli.js';
import { echo } from './extension.js';

process.exitCode = await main(process.argv.slice(2), undefined, [echo]);
