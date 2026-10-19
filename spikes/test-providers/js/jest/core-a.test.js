const u = require('node:util');
it('core probe', () => { console.log('CORE pid='+process.pid+' prev='+u.__bdd); u.__bdd = (u.__bdd||0)+1; });
