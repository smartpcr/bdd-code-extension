import { describe, it, before, after } from 'node:test';
describe('Orders', () => {
  before(() => console.log('ORD before'));
  after(() => console.log('ORD after'));
  it('places an order [qty=2]', () => console.log('RAN [qty=2]'));
  it('places an order (vip=true)', () => console.log('RAN (vip=true)'));
  it('places an order', () => console.log('RAN plain'));
  it('cancels order', () => console.log('RAN cancel'));
});
describe('Other', () => {
  before(() => console.log('OTHER before'));
  after(() => console.log('OTHER after'));
  it('unrelated', () => console.log('RAN unrelated'));
});
