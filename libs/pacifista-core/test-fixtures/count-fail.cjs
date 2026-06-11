// Increments a counter file on each invocation, always exits 1.
// Usage: node count-fail.js <counter-file>
const fs = require('node:fs');
const counterPath = process.argv[2];
const count = fs.existsSync(counterPath) ? parseInt(fs.readFileSync(counterPath, 'utf8')) : 0;
fs.writeFileSync(counterPath, String(count + 1));
process.exitCode = 1;
