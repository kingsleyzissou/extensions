// Fails on the first invocation, passes on subsequent ones.
// Usage: node flaky.js <marker-file>
const fs = require('node:fs');
const marker = process.argv[2];
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
