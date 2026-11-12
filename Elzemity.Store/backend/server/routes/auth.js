'use strict';
const express = require('express');
const crypto = require('crypto');
const { sendResetEmail } = require('../lib/password-reset-mail');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../lib/db');
const config = require('../config');
const logger = require('../lib/logger');
const { audit } = require('../lib/audit');
const { validate } = require('../middleware/core');
const limits = require('../middleware/limits');
const { createSession, setSessionCookie, clearSessionCookie, requireAuth, sha256 } = require('../middleware/auth');
const { AppError, unauthorized } = require('../lib/errors');

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptCost); // equalises timing for unknown accounts

const email = z.string().trim().toLowerCase().pipe(z.email().max(190));
const password = z.string().min(8, 'Password must be at least 8 characters').max(72);
const registerSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email,
  phone: z.string().trim().regex(/^[0-9+()\s-]{8,20}$/, 'Invalid phone number').optional(),
  password,
});
const loginSchema = z.strictObject({ email, password: z.string().min(1).max(72) });

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, permissions: u.permissions });

router.post('/register', limits.register, validate(registerSchema), async (req, res, next) => {
  try {
    const { name, email: mail, phone, password: pw } = req.body;
    const hash = await bcrypt.hash(pw, config.bcryptCost);
    try {
      await db.query("INSERT INTO users (email, name, phone, password_hash, role_id) VALUES (?,?,?,?, (SELECT id FROM roles WHERE name='customer'))", [mail, name, phone || null, hash]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      throw e;
    }
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/login', limits.login, validate(loginSchema), async (req, res, next) => {
  try {
    const { email: mail, password: pw } = req.body;
    const [u] = await db.query('SELECT u.*, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?', [mail]);
    const fail = (why) => {
      logger.security('login failed', { requestId: req.id, ip: req.ip, why, user: u?.id });
      return new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
    };
    if (!u) { await bcrypt.compare(pw, DUMMY_HASH); throw fail('unknown'); }
    if (u.locked_until && new Date(u.locked_until) > new Date()) { await bcrypt.compare(pw, DUMMY_HASH); throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Please try again later.'); }
    const ok = await bcrypt.compare(pw, u.password_hash);
    if (!ok) {
      await db.query(
        'UPDATE users SET failed_logins = failed_logins + 1, locked_until = IF(failed_logins + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), locked_until) WHERE id = ?',
        [config.loginMaxFailures, config.loginLockMinutes, u.id]);
      throw fail('bad password');
    }
    if (!u.is_active) throw fail('disabled'); // same message as bad credentials: no account enumeration
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [u.id]);
    const { token, csrf } = await createSession(u.id, req); // always a brand-new session id (no fixation)
    setSessionCookie(res, token);
    const perms = await db.query('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?', [u.role_id]);
    if (u.role !== 'customer') await audit({ ...req, user: { id: u.id } }, 'auth.staff_login', 'user', u.id, { role: u.role });
    res.json({ user: publicUser({ id: Number(u.id), name: u.name, email: u.email, role: u.role, permissions: perms.map((p) => p.code) }), csrfToken: csrf });
  } catch (e) { next(e); }
});


// Always return the same message for known and unknown emails (no account enumeration).
const resetRequestSchema = z.strictObject({ email });
const resetConfirmSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), password });
const RESET_RESPONSE = { ok: true, message: 'If the account exists, a password reset link will be sent.' };
router.post('/forgot-password', limits.passwordReset, validate(resetRequestSchema), async (req, res, next) => {
  try {
    // Never issue tokens if mail cannot be sent. Do not disclose configuration to callers.
    const smtp = config.passwordReset;
    if (!smtp.smtpHost || !smtp.smtpUser || !smtp.smtpPassword || !smtp.from) {
      logger.error('password reset mail is not configured');
      return res.status(503).json({ error: { code: 'MAIL_UNAVAILABLE', message: 'Password reset is temporarily unavailable.' } });
    }
    const [user] = await db.query('SELECT id, email FROM users WHERE email = ? AND is_active = 1', [req.body.email]);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = sha256(token);
      // Do not create unbounded tokens for a single user; at most one active token.
      await db.withTransaction(async (conn) => {
        await conn.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);
        await conn.execute('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE))', [user.id, tokenHash]);
      });
      try { await sendResetEmail(user.email, token); }
      catch (err) {
        await db.query('DELETE FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);
        logger.error('password reset email failed', { message: err.message });
        return res.status(503).json({ error: { code: 'MAIL_UNAVAILABLE', message: 'Password reset is temporarily unavailable.' } });
      }
    } else {
      // Comparable hashing work without disclosing whether an email exists.
      await bcrypt.compare('unknown-account', DUMMY_HASH);
    }
    res.json(RESET_RESPONSE);
  } catch (err) { next(err); }
});

router.post('/reset-password', limits.resetConfirm, validate(resetConfirmSchema), async (req, res, next) => {
  try {
    const hash = sha256(req.body.token);
    const newHash = await bcrypt.hash(req.body.password, config.bcryptCost);
    const changed = await db.withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        'SELECT pr.user_id FROM password_reset_tokens pr JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ? AND pr.expires_at > UTC_TIMESTAMP() AND u.is_active = 1 FOR UPDATE', [hash]);
      if (!rows.length) return false;
      const userId = rows[0].user_id;
      await conn.execute('UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), failed_logins = 0, locked_until = NULL WHERE id = ?', [newHash, userId]);
      await conn.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
      await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
      return true;
    });
    if (!changed) throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Account security is password-based; legacy 2FA endpoints have been removed.
const staffOnly = (req, res, next) => req.user?.role && req.user.role !== 'customer' ? next() : next(unauthorized());

// Staff can rotate their own password without DB access or another administrator.
// Passwords are NEVER stored in plaintext: only the bcrypt hash is saved.
const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes'),
});
router.post('/change-password', requireAuth, staffOnly, limits.passwordChange, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const newHash = await bcrypt.hash(newPassword, config.bcryptCost);
    await db.withTransaction(async (conn) => {
      // Row lock prevents concurrent password changes from both accepting a stale password.
      const [rows] = await conn.execute('SELECT password_hash FROM users WHERE id = ? AND is_active = 1 FOR UPDATE', [req.user.id]);
      const user = rows[0];
      if (!user || !await bcrypt.compare(currentPassword, user.password_hash)) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      }
      if (await bcrypt.compare(newPassword, user.password_hash)) {
        throw new AppError(422, 'PASSWORD_REUSED', 'New password must differ from the current password');
      }
      await conn.execute('UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), failed_logins = 0, locked_until = NULL WHERE id = ?', [newHash, req.user.id]);
      await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
      await conn.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [req.user.id]);
      await audit(req, 'auth.password_changed', 'user', req.user.id, null, conn);
    });
    // In socket mode, disconnect the old authenticated connection immediately too.
    require('../lib/realtime').disconnectUser(req.user.id);
    clearSessionCookie(res);
    res.json({ ok: true, reauthenticationRequired: true });
  } catch (e) { next(e); }
});

// Administrator can safely change their own login email; never create a second admin account.
const changeEmailSchema = z.strictObject({ newEmail: email, currentPassword: z.string().min(1).max(72) });
router.post('/change-email', requireAuth, limits.passwordChange, validate(changeEmailSchema), async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') throw new AppError(403, 'ADMIN_ONLY', 'Only the administrator may change this login email');
    const { newEmail, currentPassword } = req.body;
    await db.withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT email, password_hash FROM users WHERE id=? AND is_active=1 FOR UPDATE', [req.user.id]);
      const u = rows[0];
      if (!u || !await bcrypt.compare(currentPassword, u.password_hash)) throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      if (u.email.toLowerCase() === newEmail) throw new AppError(422, 'EMAIL_UNCHANGED', 'This is already your login email');
      try { await conn.execute('UPDATE users SET email=? WHERE id=?', [newEmail, req.user.id]); }
      catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EMAIL_TAKEN', 'This email is already used by another account'); throw e; }
      await conn.execute('UPDATE sessions SET revoked_at=UTC_TIMESTAMP() WHERE user_id=? AND revoked_at IS NULL', [req.user.id]);
      await conn.execute('DELETE FROM password_reset_tokens WHERE user_id=?', [req.user.id]);
      await audit(req, 'auth.admin_email_changed', 'user', req.user.id, { from: u.email, to: newEmail }, conn);
    });
    require('../lib/realtime').disconnectUser(req.user.id);
    clearSessionCookie(res);
    res.json({ ok: true, email: newEmail, reauthenticationRequired: true });
  } catch (e) { next(e); }
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  return res.json({ user: publicUser(req.user), csrfToken: req.session.csrf });
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await db.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [req.session.id]);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await db.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.sha256 = sha256;
