'use strict';
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../lib/logger');
const { MysqlRateStore } = require('../lib/mysql-rate-store');

const make = (opts, name) => (config.disableRateLimit
  ? (req, res, next) => next()
  : rateLimit({
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => {
      logger.security('rate limit hit', { requestId: req.id, path: req.path, ip: req.ip });
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.', requestId: req.id } });
    },
    ...opts,
    ...(config.rateLimitStore === 'mysql' && name !== 'api' ? { store: new MysqlRateStore(name) } : {}),
  }));

module.exports = {
  api: make({ windowMs: 60 * 1000, limit: 300 }, 'api'),
  login: make({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true }, 'login'),
  passwordReset: make({ windowMs: 60 * 60 * 1000, limit: 5 }, 'passwordReset'),
  resetConfirm: make({ windowMs: 15 * 60 * 1000, limit: 10 }, 'resetConfirm'),
  register: make({ windowMs: 60 * 60 * 1000, limit: 10 }, 'register'),
  createOrder: make({ windowMs: 10 * 60 * 1000, limit: 15 }, 'createOrder'),
  upload: make({ windowMs: 60 * 60 * 1000, limit: 20 }, 'upload'),
  lookup: make({ windowMs: 10 * 60 * 1000, limit: 60 }, 'lookup'),
  passwordChange: make({ windowMs: 15 * 60 * 1000, limit: 5 }, 'passwordChange'),
};
