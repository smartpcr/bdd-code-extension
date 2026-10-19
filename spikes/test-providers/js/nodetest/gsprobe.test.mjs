import { it } from 'node:test';
it('probe', () => console.log('PROBE pid='+process.pid+' gs='+globalThis.__GS+' env='+process.env.GS_ENV));
