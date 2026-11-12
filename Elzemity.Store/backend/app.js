'use strict';
// cPanel / CloudLinux Passenger startup file. Set Application Root to backend/ and startup file to app.js.
// Reuse the exact same application entry point as npm start (no duplicate business logic).
require('./server/index');
