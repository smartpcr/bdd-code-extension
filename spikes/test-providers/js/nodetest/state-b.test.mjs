import { describe, it } from 'node:test';
import s from '../shared/state.cjs';
describe('State b', () => {
  it('t1', async () => { const t=Date.now(); await new Promise(r=>setTimeout(r,300)); console.log('STATE b t1 pid='+process.pid+' id='+s.id+' start='+t+' gs='+globalThis.__GS); globalThis.__GS='set-by-b'; });
  it('t2', async () => { const t=Date.now(); await new Promise(r=>setTimeout(r,300)); console.log('STATE b t2 pid='+process.pid+' id='+s.id+' start='+t); });
});
