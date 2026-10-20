#!/usr/bin/env node
// The greeter's suiterun: lint, run and list its suites with its extension.
import { main } from '@bdd-suite/runtime/cli';
import { greeterExtension } from '../greeter.mjs';

process.exitCode = await main(process.argv.slice(2), undefined, [greeterExtension]);
