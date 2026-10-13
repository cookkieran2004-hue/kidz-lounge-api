// The credentials the owner asked every provider to keep on file (Kieran,
// Oct 2026), picked from a list so everyone's look the same (mirrors the
// frontend's src/credentialTypes.js). Expiration dates are typed in, never
// worked out ("I do not want expirations to auto calculate").
// Providers (staff with a linked provider) get an "Enter your credentials"
// task until all of these are on file; it closes by itself once they are.

const REQUIRED_CREDENTIALS = ['Physical', 'License/Registration', 'Liability Insurance', 'Mandated Reporter', 'OSHA Training', 'SCR', 'Trainings', 'License Number', 'NPI Number'];

// Names are compared without case, spaces or punctuation, so "License/
// Registration" and "license / registration" match; a few older spellings
// count too ("OSHA", "2026 Trainings").
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  'OSHA Training': [/^osha(training)?$/],
  Trainings: [/^(\d{4})?trainings?$/],
  'License Number': [/^license(number|no|num)?$/],
  'NPI Number': [/^npi(number|no|num)?$/],
};
function typeOf(name) {
  const n = norm(name);
  return REQUIRED_CREDENTIALS.find(r => norm(r) === n || (ALIASES[r] || []).some(re => re.test(n))) || null;
}
function missingRequired(names) {
  const have = new Set(names.map(typeOf).filter(Boolean));
  return REQUIRED_CREDENTIALS.filter(r => !have.has(r));
}

const TASK_KEY = 'credentials_required';

// Opens (or closes) a provider's "Enter your credentials" task to match what
// they have on file. Never throws: a reminder must not break saving.
async function syncRequiredTask(db, username) {
  try {
    const staff = (await db.query('SELECT username, provider_name, archived FROM "Staff" WHERE username=$1', [username])).rows[0];
    const names = (await db.query('SELECT credential_name FROM "StaffCredentials" WHERE username=$1', [username])).rows.map(r => r.credential_name);
    const missing = staff && staff.provider_name && !staff.archived ? missingRequired(names) : [];
    const open = (await db.query(`SELECT id FROM "Tasks" WHERE assigned_to=$1 AND deadline_type=$2 AND status <> 'done'`, [username, TASK_KEY])).rows;
    if (!missing.length) {
      if (open.length) await db.query(`UPDATE "Tasks" SET status='done', completed_at=now() WHERE assigned_to=$1 AND deadline_type=$2 AND status <> 'done'`, [username, TASK_KEY]);
      return false;
    }
    if (open.length) return false;
    await db.query(
      `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, status, is_automated, related_patient_id, deadline_type, deadline_date, due_date)
       VALUES ('Enter your credentials', $1, $2, 'system', 'open', true, NULL, $3, CURRENT_DATE, NULL)`,
      [`Please add your required credentials on My profile, Credentials tab. Still needed: ${missing.join(', ')}. Type each expiration date in yourself. This task closes by itself once they're all on file.`, username, TASK_KEY]
    );
    return true;
  } catch (err) {
    console.error('Credentials task not updated', err);
    return false;
  }
}

module.exports = { REQUIRED_CREDENTIALS, typeOf, missingRequired, syncRequiredTask };
