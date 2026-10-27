// prints the current TOTP code for a secret - handy for demos without a phone
const totp = require('../src/lib/totp');

const secret = process.argv[2];
if (!secret) {
  console.error('usage: node scripts/totp.js <base32-secret>');
  process.exit(1);
}
console.log(totp.generate(secret));
