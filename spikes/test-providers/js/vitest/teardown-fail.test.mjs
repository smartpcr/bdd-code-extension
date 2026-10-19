import { describe, it, expect, beforeAll, afterAll } from 'vitest';
describe('Suite TeardownFail', () => {
  beforeAll(() => console.log('TD beforeAll'));
  afterAll(() => { console.log('TD afterAll throwing'); throw new Error('suite teardown boom'); });
  it('passes one', () => { expect(1).toBe(1); });
  it('passes two', () => { expect(2).toBe(2); });
});
