'use strict';
/** Encrypted upload/receipt backup. Requires `tar` in PATH; run separately from DB backup.
 * tar -> gzip -> AES-256-GCM, verified by full decrypt and tar header check.
 * Does NOT serve files publicly, delete source files, or change the database.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const config = require('../server/config');
const { encryptStream, decryptToSqlStream, sha256File } = require('./backup-lib');

const stamp = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}-${crypto.randomBytes(3).toString('hex')}`;

async function verifyUploadsArchive(file) {
  const hash = await sha256File(file);
  let first = Buffer.alloc(0);
  let bytes = 0;
  for await (const chunk of decryptToSqlStream(file)) {
    bytes += chunk.length;
    if (first.length < 512) first = Buffer.concat([first, chunk.subarray(0, 512 - first.length)]);
  }
  if (bytes < 1024 || first.subarray(257, 262).toString('ascii') !== 'ustar') {
    throw new Error('Upload archive failed tar integrity check');
  }
  return hash;
}

async function runUploadBackup() {
  if (!fs.existsSync(config.upload.dir) || fs.readdirSync(config.upload.dir).length === 0) {
    console.log('Upload backup skipped: upload folder is empty.');
    return { skipped: true };
  }
  fs.mkdirSync(config.backup.dir, { recursive: true, mode: 0o700 });
  const name = `uploads-${stamp()}.tar.gz.enc`;
  const file = path.join(config.backup.dir, name);
  try {
    const tar = spawn(process.env.TAR_BIN || 'tar', ['-C', config.upload.dir, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    tar.stderr.on('data', (d) => { stderr += d.toString().slice(0, 300); });
    const exited = new Promise((resolve, reject) => {
      tar.on('error', reject);
      tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.slice(0, 300)}`)));
    });
    await Promise.all([
      pipeline(tar.stdout, zlib.createGzip(), encryptStream(), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 })),
      exited,
    ]);
    const hash = await verifyUploadsArchive(file);
    fs.writeFileSync(`${file}.sha256`, `${hash}  ${name}\n`, { mode: 0o600 });
    if (config.backup.offsiteDir) {
      fs.mkdirSync(config.backup.offsiteDir, { recursive: true, mode: 0o700 });
      const dest = path.join(config.backup.offsiteDir, name);
      fs.copyFileSync(file, dest);
      fs.copyFileSync(`${file}.sha256`, `${dest}.sha256`);
      if (await verifyUploadsArchive(dest) !== hash) throw new Error('Upload backup offsite copy mismatch');
    }
    const files = fs.readdirSync(config.backup.dir).filter((f) => /^uploads-.*\.tar\.gz\.enc$/.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - config.backup.keep))) {
      fs.rmSync(path.join(config.backup.dir, old));
      fs.rmSync(path.join(config.backup.dir, `${old}.sha256`), { force: true });
    }
    console.log(`Encrypted upload backup OK: ${name}`);
    return { name, file };
  } catch (err) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.sha256`, { force: true });
    throw err;
  }
}
module.exports = { runUploadBackup, verifyUploadsArchive };
if (require.main === module) runUploadBackup().catch((e) => { console.error('UPLOAD BACKUP FAILED:', e.message); process.exitCode = 1; });
