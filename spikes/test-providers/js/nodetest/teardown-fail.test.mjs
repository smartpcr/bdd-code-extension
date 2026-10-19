import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
describe('Suite TeardownFail', () => {
  before(() => console.log('TD before'));
  after(() => { console.log('TD after throwing'); throw new Error('suite teardown boom'); });
  it('passes one', () => { assert.equal(1, 1); });
  it('passes two', () => { assert.equal(2, 2); });
});
