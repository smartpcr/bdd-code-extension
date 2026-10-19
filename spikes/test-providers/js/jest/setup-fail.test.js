describe('Suite SetupFail', () => {
  beforeAll(() => { console.log('SF beforeAll throwing'); throw new Error('suite setup boom'); });
  afterAll(() => console.log('SF afterAll RAN'));
  beforeEach(() => console.log('SF beforeEach RAN'));
  it('case a', () => { console.log('SF case a body RAN'); });
  it('case b', () => { console.log('SF case b body RAN'); });
});
