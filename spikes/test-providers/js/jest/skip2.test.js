describe('Skip2', () => {
  it('early return', () => { console.log('SKIP: reason'); return; });
  it('pending()', () => { pending('reason'); });
  it.todo('todo case');
  it.skip('static skip', () => {});
  it('process probe', () => { console.log('PROC probe pid='+process.pid+' __x='+process.__x+' sym='+globalThis[Symbol.for('bdd.x')]); process.__x = 'set'; });
});
