import { describe, it, before, after, beforeEach } from 'node:test';
describe('Suite SetupFail', () => {
  before(() => { console.log('SF before throwing'); throw new Error('suite setup boom'); });
  after(() => console.log('SF after RAN'));
  beforeEach(() => console.log('SF beforeEach RAN'));
  it('case a', () => { console.log('SF case a body RAN'); });
  it('case b', () => { console.log('SF case b body RAN'); });
});
