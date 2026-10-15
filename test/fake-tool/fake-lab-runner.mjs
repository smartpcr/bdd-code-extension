// A stand-in for a binding program on the lab path (plan B6.4, B6.5). `list`
// prints two cases; `run` appends its argv as one JSON line to the file named
// by BDD_FAKE_RUN_LOG and then sleeps until it is killed, like a lab run that
// is still working.
import { appendFileSync } from 'fs';

const args = process.argv.slice(2);
if (args[0] === 'list') {
  process.stdout.write('_scratch-lab.yml  first\n_scratch-lab.yml  second\n');
} else if (args[0] === 'run') {
  if (process.env.BDD_FAKE_RUN_LOG) appendFileSync(process.env.BDD_FAKE_RUN_LOG, JSON.stringify(args) + '\n');
  setTimeout(() => {}, 600_000);
} else {
  process.exitCode = 2;
}
