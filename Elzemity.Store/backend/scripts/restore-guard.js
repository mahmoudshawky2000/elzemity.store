'use strict';
/** Read mysql2 result as [rows, fields]. No database mutations occur in this helper. */
function assertEmptyTarget(result) {
  const rows = result && result[0];
  const raw = rows && rows[0] && rows[0].n;
  const count = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Cannot verify that the target database is empty; restore cancelled.');
  if (count !== 0) throw new Error('Target database is not empty. Create a separate empty staging database; existing data was not touched.');
}
function assertProductionRestoreAllowed(target, production, overwrite, confirmation) {
  if (target !== production) return;
  if (!overwrite || confirmation !== 'YES_I_UNDERSTAND_DATA_LOSS') {
    throw new Error('Refusing to restore to the live database. Requires --overwrite-production AND ALLOW_PRODUCTION_RESTORE=YES_I_UNDERSTAND_DATA_LOSS.');
  }
}
module.exports = { assertEmptyTarget, assertProductionRestoreAllowed };
