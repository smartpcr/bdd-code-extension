#!/usr/bin/env node
// This workspace's suiterun, TypeScript binding: the runtime's command line
// with the {{name}} extension. The Suite Authoring extension builds and runs it
// (.vscode/settings.json, bddSuite.bindings.typescript).
import { main } from '@bdd-suite/runtime/cli';
import { {{prefix}}Extension } from './extension.js';

process.exitCode = await main(process.argv.slice(2), undefined, [{{prefix}}Extension]);
