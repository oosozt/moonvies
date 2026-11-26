// Prints a sign-in token for a device that can't show the sign-in page, like the Glass Home TV launcher:
//   node device-token.mjs <username> [profile name]
// It acts as that profile (its "Continue watching"). Run it on the server, in this folder.
// Signing that account out everywhere (or changing its password) cancels it.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.mjs';

const [user, profile] = process.argv.slice(2);
if (!user) { console.error('Usage: node device-token.mjs <username> [profile name]'); process.exit(1); }
auth.openDb(join(fileURLToPath(new URL('.', import.meta.url)), 'moonvies.db'));
try { console.log(auth.deviceToken(user, profile, 'Glass Home')); }
catch (e) { console.error(e.message); process.exit(1); }
