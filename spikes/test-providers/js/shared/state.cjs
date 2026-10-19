// module-level singleton to probe per-worker state
const s = { id: Math.random().toString(36).slice(2, 8), pid: process.pid, hits: [] };
module.exports = s;
