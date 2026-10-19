module.exports = async () => { globalThis.__GS = 'set-in-globalSetup'; process.env.GS_ENV = 'env-from-globalSetup'; console.log('GLOBALSETUP pid=' + process.pid); };
