import { describe, it, beforeAll, afterAll } from 'vitest';
describe('Orders', () => {
  beforeAll(() => console.log('ORD beforeAll'));
  afterAll(() => console.log('ORD afterAll'));
  it('places an order [qty=2]', () => console.log('RAN [qty=2]'));
  it('places an order (vip=true)', () => console.log('RAN (vip=true)'));
  it('places an order', () => console.log('RAN plain'));
  it('cancels order', () => console.log('RAN cancel'));
});
describe('Other', () => {
  beforeAll(() => console.log('OTHER beforeAll'));
  afterAll(() => console.log('OTHER afterAll'));
  it('unrelated', () => console.log('RAN unrelated'));
});
