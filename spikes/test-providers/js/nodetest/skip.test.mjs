import { describe, it, before, beforeEach } from 'node:test';
describe('Skip in test', () => {
  it('t.skip with reason', (t) => { t.skip('no lab available'); console.log('AFTER SKIP still prints (no throw)'); });
});
describe('Skip in beforeEach', () => {
  beforeEach((t) => { t.skip('skipped from beforeEach'); });
  it('case x', () => { console.log('X body RAN'); });
});
describe('Skip in before (suite)', () => {
  before((s) => { console.log('before arg type', s?.constructor?.name, typeof s?.skip); });
  it('case y', () => {});
});
