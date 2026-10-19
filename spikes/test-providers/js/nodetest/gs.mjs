export async function globalSetup() { globalThis.__GS='x'; process.env.GS_ENV='env-from-gs'; console.log('NODE GLOBALSETUP pid='+process.pid); }
export async function globalTeardown() { console.log('NODE GLOBALTEARDOWN'); }
