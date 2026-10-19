const s = require('../shared/state.cjs');
describe('State b', () => {
  it('t1', async () => { s.hits.push(''); const t=Date.now(); await new Promise(r=>setTimeout(r,300)); console.log('STATE b t1 pid='+process.pid+' id='+s.id+' hits='+s.hits.join(',')+' start='+t+' gs='+globalThis.__GS+' env='+process.env.GS_ENV); });
  it('t2', async () => { s.hits.push(''); const t=Date.now(); await new Promise(r=>setTimeout(r,300)); console.log('STATE b t2 pid='+process.pid+' id='+s.id+' start='+t); });
});
