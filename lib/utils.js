// Supports genuine partial updates on top of Postgres's own COALESCE, which
// can't tell "field omitted from the request" apart from "field explicitly
// sent as empty, to clear it." A field missing from the body entirely keeps
// its current value; a field that IS present (even as '' or null) is treated
// as an intentional change and normalized the same way a full-record save
// always has been. This means a caller can safely send just the one field
// it's changing -- no more reconstructing and re-sending an entire record
// just to edit a single cell.
function mergedField(body, key, existingRow, normalize = (v) => v || null) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return existingRow[key];
  return normalize(body[key]);
}

// Same "what do we call this person" logic everywhere a name needs to be
// shown -- preferred name first, then first+last, falling back to username.
function displayNameFor(staffLike) {
  if (staffLike.preferred_name) return staffLike.preferred_name;
  const full = [staffLike.first_name, staffLike.last_name].filter(Boolean).join(' ');
  return full || staffLike.username;
}

// Looks up the linked Staff account directly by case_manager_username --
// replacing the old fuzzy substring match ("does the text contain
// 'heather'?") that broke on typos, name changes, or a new case manager
// who wasn't Heather or Fran. Falls back to notifying all admins when
// nothing is linked, or when the linked account has since been archived --
// same fallback behavior as before, just triggered by a real state check
// instead of a failed guess.
function resolveCaseManagerAssignees(caseManagerUsername, staffList, adminUsernames) {
  if (!caseManagerUsername) return adminUsernames;
  const match = staffList.find(s => s.username === caseManagerUsername);
  if (match) return [match.username];
  return adminUsernames;
}

// Figures out which Provider is signing a clinical document: an explicit
// provider_id in the request wins (e.g. front-desk staff transcribing on
// behalf of a therapist); otherwise falls back to whichever Provider the
// current staff account is linked to (Staff.provider_name -> Providers.Name,
// the same name-based link used everywhere else in the app).
async function resolveProviderId(db, currentUser, explicitProviderId) {
  if (explicitProviderId) return explicitProviderId;
  if (currentUser.providerName) {
    const res = await db.query('SELECT id FROM "Providers" WHERE "Name"=$1', [currentUser.providerName]);
    if (res.rows[0]) return res.rows[0].id;
  }
  return null;
}

async function generateUniqueMRN(db) {
  for (let attempts = 0; attempts < 20; attempts++) {
    const candidate = String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
    const existing = await db.query('SELECT id FROM "Patients" WHERE mrn=$1', [candidate]);
    if (!existing.rows[0]) return candidate;
  }
  throw new Error('Could not generate a unique MRN after 20 attempts.');
}

module.exports = { mergedField, displayNameFor, resolveCaseManagerAssignees, resolveProviderId, generateUniqueMRN };
