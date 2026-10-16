#!/usr/bin/env node
// The sample workspace's suiterun, TypeScript binding: the runtime's command
// line with this workspace's extension.
import { main } from '@bdd-suite/runtime/cli';
import { shop } from './extension.js';

process.exitCode = await main(process.argv.slice(2), undefined, [shop]);
