'use strict';
/** Restore a verified encrypted upload backup to a NEW EMPTY STAGING DIRECTORY ONLY.
 * Never overwrites the live uploads directory or existing files.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const config = require('../server/config');
const { decryptToSqlStream } = require('./backup-lib');
const { verifyUploadsArchive } = require('./backup-uploads');

const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
async function runTar(file, args, capture = false) {
  const child = spawn(process.env.TAR_BIN || 'tar', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', (d) => { if (capture) output += d.toString(); });
  child.stderr.on('data', (d) => { error += d.toString().slice(0, 300); });
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${error.slice(0, 300)}`)));
  });
  // `tar -tf` may close stdin after the end-of-archive marker while gzip still
  // has padding. The archive has already passed full authenticated verification.
  const [piped, exited] = await Promise.allSettled([pipeline(decryptToSqlStream(file), child.stdin), exit]);
  if (exited.status === 'rejected') throw exited.reason;
  if (piped.status === 'rejected' && !['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(piped.reason.code)) throw piped.reason;
  return output;
}
async function restoreUploads(file, target) {
  const source = path.resolve(file);
  const destination = path.resolve(target);
  const live = path.resolve(config.upload.dir);
  if (!fs.existsSync(source) || !source.endsWith('.tar.gz.enc')) throw new Error('Invalid or missing encrypted uploads backup');
  if (overlaps(destination, live)) throw new Error('Refusing to restore into or above/below live uploads directory');
  if (/(^|[\\/])public_html([\\/]|$)/i.test(destination)) throw new Error('Never restore private receipts inside public_html');
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('Restore target must be empty');
  const actualHash = await verifyUploadsArchive(source); // checks full authenticated decryption before any extraction
  if (fs.existsSync(`${source}.sha256`)) {
    const expected = fs.readFileSync(`${source}.sha256`, 'utf8').split(/\s+/)[0];
    if (actualHash !== expected) throw new Error('Upload backup SHA-256 mismatch');
  }
  // Check tar listing and reject symbolic/hard links and unexpected file types.
  const listing = await runTar(source, ['-tvf', '-'], true);
  for (const line of listing.split(/\r?\n/).filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) throw new Error('Unsafe archive entry type (links/devices not allowed)');
  }
  const names = await runTar(source, ['-tf', '-'], true);
  for (const name of names.split(/\r?\n/).filter(Boolean)) {
    const parts = name.split('/');
    if (name.startsWith('/') || name.includes('\\') || parts.includes('..')) throw new Error('Unsafe archive path');
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  await runTar(source, ['-xf', '-', '-C', destination, '--no-same-owner', '--no-same-permissions']);
  console.log(`Uploads restored to STAGING only: ${destination}`);
  return { destination };
}
module.exports = { restoreUploads };
if (require.main === module) {
  const [file, flag, target] = process.argv.slice(2);
  if (!file || flag !== '--target-dir' || !target) {
    console.error('Usage: node scripts/restore-uploads.js <uploads-archive.tar.gz.enc> --target-dir <NEW_EMPTY_STAGING_DIRECTORY>');
    process.exitCode = 2;
  } else restoreUploads(file, target).catch((e) => { console.error('UPLOAD RESTORE FAILED:', e.message); process.exitCode = 1; });
}
