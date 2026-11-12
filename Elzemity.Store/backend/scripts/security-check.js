'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '../..');
function git(args) { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }); } catch { return null; } }
function isSensitive(name) { return /(^|\/)(\.env($|\.(?!example$|egyhosting\.example$))|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key)$)/i.test(name); }
let bad = 0;
const tracked = git(['ls-files']);
if (tracked === null) console.log('Git repository not available locally: Git history could not be checked.');
else {
  const current = tracked.split(/\r?\n/).filter(isSensitive);
  if (current.length) { console.error('SECURITY WARNING: sensitive files are currently tracked:', current.map(x => path.basename(x)).join(', ')); bad++; }
  else console.log('No obvious .env/private-key filenames currently tracked.');
  const history = git(['log', '--all', '--name-only', '--pretty=format:']);
  if (history === null) console.log('Git history unavailable.');
  else if (history.split(/\r?\n/).some(isSensitive)) { console.error('SECURITY WARNING: Git history includes a sensitive filename. Rotate any exposed secrets; deleting the file now does not erase history.'); bad++; }
  else console.log('No obvious sensitive filenames in accessible Git history (not a full secret scan).');
}
if (fs.existsSync(path.join(root, 'backend/.env'))) console.log('Local backend/.env exists. Keep it OUT of ZIP/Git/public_html.');
if (bad) process.exitCode = 1;
