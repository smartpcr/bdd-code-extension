import { describe, it, beforeAll, beforeEach } from 'vitest';
describe('Skip in test', () => {
  it('ctx.skip with reason', (ctx) => { ctx.skip('no lab available'); console.log('AFTER SKIP should not print'); });
  it('ctx.skip(cond, reason)', (ctx) => { ctx.skip(true, 'conditional reason'); });
});
describe('Skip in beforeEach', () => {
  beforeEach((ctx) => { ctx.skip('skipped from beforeEach'); });
  it('case x', () => { console.log('X body RAN'); });
});
describe('Suite-level skip via beforeAll flag', () => {
  let reason;
  beforeAll(() => { reason = 'suite precondition unmet'; });
  beforeEach((ctx) => { if (reason) ctx.skip(reason); });
  it('case y', () => { console.log('Y body RAN'); });
});
