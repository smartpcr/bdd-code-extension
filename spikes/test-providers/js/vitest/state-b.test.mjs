import { describe, it } from 'vitest';
import s from '../shared/state.cjs';
import u from 'node:util';
describe('State b', () => {
  it('t1', async () => { const t=Date.now(); await new Promise(r=>setTimeout(r,300)); console.log('STATE b t1 pid='+process.pid+' id='+s.id+' core='+u.__bdd+' start='+t+' gs='+globalThis.__GS+' env='+process.env.GS_ENV); u.__bdd=(u.__bdd||0)+1; });
  it('t2', async () => { const t=Date.now(); await new Promise(r=>setTimeout(r,300)); console.log('STATE b t2 pid='+process.pid+' id='+s.id+' start='+t); });
});
