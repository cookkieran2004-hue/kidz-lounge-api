// One place for how provider names work.
//
// Providers are referenced by NAME (not id) across the database, so a rename
// has to update every table that stores it, in the same transaction:
//   Appointments.provider, Out_of_Office.provider, RecurringSeries.provider,
//   OOO_RecurringSeries.provider, Staff.provider_name,
//   ProviderUsualSchedule.provider  <- was previously missed, which silently
//                                      dropped a provider's weekly hours on rename
//
// Rule (set Sept 2026): a provider linked to a staff account is always named
// after that person -- preferred name if they have one, otherwise first
// name, plus last name. The staff routes call syncLinkedProvider() after
// every create/update so the two can't drift apart.

const { displayNameFor } = require('./utils');

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function providerNamePartsFor(staff) {
  const first = (staff.preferred_name || staff.first_name || '').trim();
  const last = (staff.last_name || '').trim();
  return { first, last, name: first && last ? `${first} ${last}` : null };
}

async function assertNameAvailable(client, name, exceptProviderId = null) {
  const res = await client.query(
    'SELECT id FROM "Providers" WHERE "Name"=$1 AND ($2::uuid IS NULL OR id <> $2::uuid)',
    [name, exceptProviderId]
  );
  if (res.rows[0]) {
    throw new HttpError(409, `Another provider is already named "${name}". Give this person a different preferred name so the two can be told apart on the schedule.`, { nameTaken: name });
  }
}

async function cascadeProviderRename(client, oldName, newName) {
  if (!oldName || oldName === newName) return;
  await client.query('UPDATE "Appointments" SET provider=$1 WHERE provider=$2', [newName, oldName]);
  await client.query('UPDATE "Out_of_Office" SET provider=$1 WHERE provider=$2', [newName, oldName]);
  await client.query('UPDATE "RecurringSeries" SET provider=$1 WHERE provider=$2', [newName, oldName]);
  await client.query('UPDATE "OOO_RecurringSeries" SET provider=$1 WHERE provider=$2', [newName, oldName]);
  await client.query('UPDATE "Staff" SET provider_name=$1 WHERE provider_name=$2', [newName, oldName]);
  await client.query('UPDATE "ProviderUsualSchedule" SET provider=$1 WHERE provider=$2', [newName, oldName]);
  // Scheduled hour changes (only once that table exists -- a failed query
  // inside this transaction would abort the whole rename).
  const changes = await client.query(`SELECT to_regclass('"ProviderScheduleChanges"') IS NOT NULL AS ok`);
  if (changes.rows[0]?.ok) await client.query('UPDATE "ProviderScheduleChanges" SET provider=$1 WHERE provider=$2', [newName, oldName]);
}

// Renames the staff member's linked provider to match their name, if it
// doesn't already. Returns the provider's (possibly new) Name, or null when
// the account isn't linked to an existing provider. Must run inside the
// caller's transaction so a name clash rolls back the staff change too.
async function syncLinkedProvider(client, staff) {
  if (!staff.provider_name) return null;
  const provRes = await client.query('SELECT id, "Name", first_name, last_name FROM "Providers" WHERE "Name"=$1', [staff.provider_name]);
  const provider = provRes.rows[0];
  if (!provider) return null;

  const want = providerNamePartsFor(staff);
  if (!want.name) return provider.Name;
  if (provider.Name === want.name && provider.first_name === want.first && provider.last_name === want.last) return provider.Name;

  if (provider.Name !== want.name) await assertNameAvailable(client, want.name, provider.id);
  await client.query('UPDATE "Providers" SET "Name"=$1, first_name=$2, last_name=$3 WHERE id=$4', [want.name, want.first, want.last, provider.id]);
  await cascadeProviderRename(client, provider.Name, want.name);
  return want.name;
}

// A provider can belong to only one active account.
async function assertProviderNotLinkedElsewhere(client, providerName, exceptStaffId = null) {
  if (!providerName) return;
  const res = await client.query(
    'SELECT username, first_name, last_name, preferred_name FROM "Staff" WHERE provider_name=$1 AND archived=false AND ($2::int IS NULL OR id <> $2::int)',
    [providerName, exceptStaffId]
  );
  if (res.rows[0]) {
    throw new HttpError(409, `${providerName} is already linked to another account (${displayNameFor(res.rows[0])}).`);
  }
}

module.exports = {
  HttpError, providerNamePartsFor, assertNameAvailable, cascadeProviderRename,
  syncLinkedProvider, assertProviderNotLinkedElsewhere,
};
