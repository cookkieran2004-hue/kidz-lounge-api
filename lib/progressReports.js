// EI progress reports (the "ei" feature, PedsDesk only; Kieran, Oct 2026;
// migrations/2026-11-06_ei_progress_reports.sql, routes/progressReports.js).
//
// Follows the NYC Provider Progress Note (9/2024) and its instructions:
// every provider seeing an EI child writes one before each IFSP review (the
// end of an IFSP period): '6' for a period ending at a 6-month review
// (Initial, Annual), '12' for one ending at the annual (Review), plus
// amendment reports on request. NYC wants it with the service coordinator 2
// weeks before the review; PedsDesk makes it due REPORT_LEAD_DAYS (21)
// before, so the office has a week to approve it. Every IFSP outcome and
// developmental step is rated (no progress / emerging / achieved) with keep
// or remove. The parent reviews it and signs on the provider's device, the
// provider certifies and signs, then the office approves (or returns it for
// an addendum) and marks it sent.
const { REPORT_LEAD_DAYS, addDays } = require('./ifsp');
const history = require('./eiHistory');
const patientPrograms = require('./patientPrograms');
const { clinicToday } = require('./caseload');

const RATINGS = ['none', 'emerging', 'achieved'];
const COMM_METHODS = ['communication_book', 'family_activity_sheet', 'emails', 'phone_calls', 'session_notes', 'other'];
const DELIVERY = ['in_person', 'telehealth', 'hybrid'];
// A report shows on the to-do list from this many days before it's due.
const SHOW_FROM_DAYS = 45;
// Consecutive missed sessions NYC asks about ("more than three").
const GAP_SESSIONS = 4;

// '6' / '12' from the IFSP type (the patient form's list), or null for an
// amendment (written on request, not on a schedule).
function reportTypeOf(ifspType) {
  const t = String(ifspType || '');
  if (/amend/i.test(t)) return null;
  if (/review/i.test(t)) return '12';
  return '6';
}
const dueDateOf = (ifspEnd) => (ifspEnd ? addDays(String(ifspEnd).slice(0, 10), -REPORT_LEAD_DAYS) : null);
const letter = (j) => String.fromCharCode(97 + j);
const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const LOCATION_LABEL = { home: "Child's home", community: 'Community (e.g. child care)', facility: 'Facility / agency' };

// Missed runs of GAP_SESSIONS or more in a row, from the provider's EI
// sessions with the child (sorted by date), as text for the form.
function gapsText(sessions) {
  const runs = [];
  let run = [];
  const flush = () => { if (run.length >= GAP_SESSIONS) runs.push(run); run = []; };
  for (const s of sessions) {
    if (s.cancelled) run.push(s);
    else flush();
  }
  flush();
  if (!runs.length) return '';
  return runs.map(r => `${r[0].date} to ${r[r.length - 1].date}: ${r.length} sessions in a row missed (${[...new Set(r.map(x => x.appointment_status))].join(' / ')}).`).join('\n');
}

// The starting answers for a new report (the provider edits all of them).
// `sessions` = this provider's EI sessions with the child in the IFSP period
// (routes/sessionNotes.js eiSessionsFor), `notes` = their session notes.
async function prefill(db, { patient, ifsp, provider, service, sessions, notes }) {
  const [first, settings, programs, versions] = await Promise.all([
    db.query('SELECT MIN(appointment_date) AS d FROM "Appointments" WHERE patient_name=$1 AND provider=$2 AND deleted = false AND appointment_status NOT IN (\'Canceled\', \'No Show\')', [patient.Name, provider]),
    db.query('SELECT agency_name, npi FROM "EiBillingSettings" WHERE id = 1').catch(() => ({ rows: [] })),
    patientPrograms.historyFor(db, [patient.id]),
    history.versionsFor(db, 'child', [patient.id]),
  ]);
  const today = clinicToday();
  const mandate = (programs[patient.id] || []).find(r => r.program === 'EI' && r.service === service && patientPrograms.activeOn(r, today));
  const child = history.versionOn(versions[patient.id] || [], today) || {};
  const signed = notes.filter(n => n.provider_signed_at && !n.cancelled);
  const inPerson = signed.filter(n => n.delivery === 'in_person').length;
  const telehealth = signed.filter(n => n.delivery === 'telehealth').length;
  return {
    details: {
      agency_name: settings.rows[0]?.agency_name || '',
      agency_id: settings.rows[0]?.npi || '',
      interventionist_phone: '',
      sc_name: ifsp.sc_name || '',
      eiod_name: '',
      languages: '',
      authorized_frequency: mandate ? `${mandate.sessions} x ${mandate.minutes}` : '',
      start_date: day10(first.rows[0]?.d) || '',
      delivery: inPerson && telehealth ? 'hybrid' : telehealth ? 'telehealth' : inPerson ? 'in_person' : '',
      sessions_in_person: inPerson,
      sessions_telehealth: telehealth,
      locations: [...new Set(signed.map(n => LOCATION_LABEL[n.location]).filter(Boolean))].join(', '),
      parent_participated: signed.length ? signed.some(n => (n.participants || []).includes('parent')) : null,
      comm_methods: signed.length ? ['session_notes'] : [],
      comm_other: '',
      comm_frequency: signed.length ? 'After every session (session note)' : '',
      gaps: gapsText(sessions),
      diagnoses: child.diagnosis_codes || '',
      at_using: false,
      at_requested: false,
      at_details: '',
      proposed_none: false,
    },
    outcomes: (ifsp.outcomes || []).map((o, i) => ({
      outcome_id: o.id, number: i + 1, text: o.outcome, rating: '', keep: '', at_ifsp: true, change_note: '',
      steps: (o.steps || []).map((st, j) => ({ label: `${i + 1}${letter(j)}`, text: st, rating: '', keep: '' })),
    })),
  };
}

// Cleans what the provider sends (sizes and allowed values only; the
// completeness check is missingForSigning).
function cleanDraft(body) {
  const b = body || {};
  const t = (v, max) => (v === undefined || v === null ? '' : String(v).slice(0, max));
  const d = b.details || {};
  const pick = (v, allowed) => (allowed.includes(v) ? v : '');
  const yn = (v) => (v === true || v === false ? v : null);
  const details = {
    agency_name: t(d.agency_name, 200), agency_id: t(d.agency_id, 60), interventionist_phone: t(d.interventionist_phone, 40),
    sc_name: t(d.sc_name, 200), eiod_name: t(d.eiod_name, 200), languages: t(d.languages, 200),
    authorized_frequency: t(d.authorized_frequency, 60), start_date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.start_date || '')) ? d.start_date : '',
    delivery: pick(d.delivery, DELIVERY),
    sessions_in_person: Math.max(0, Math.min(999, Number(d.sessions_in_person) || 0)), sessions_telehealth: Math.max(0, Math.min(999, Number(d.sessions_telehealth) || 0)),
    locations: t(d.locations, 500), parent_participated: yn(d.parent_participated),
    comm_methods: [...new Set((Array.isArray(d.comm_methods) ? d.comm_methods : []).filter(x => COMM_METHODS.includes(x)))],
    comm_other: t(d.comm_other, 300), comm_frequency: t(d.comm_frequency, 300), gaps: t(d.gaps, 3000), diagnoses: t(d.diagnoses, 500),
    at_using: !!d.at_using, at_requested: !!d.at_requested, at_details: t(d.at_details, 3000), proposed_none: !!d.proposed_none,
  };
  const outcomes = (Array.isArray(b.outcomes) ? b.outcomes : []).slice(0, 30).map(o => ({
    outcome_id: Number(o.outcome_id) || null, number: Number(o.number) || null, text: t(o.text, 2000),
    rating: pick(o.rating, RATINGS), keep: pick(o.keep, ['keep', 'remove']), at_ifsp: o.at_ifsp !== false, change_note: t(o.change_note, 2000),
    steps: (Array.isArray(o.steps) ? o.steps : []).slice(0, 12).map(s => ({ label: t(s.label, 6), text: t(s.text, 1000), rating: pick(s.rating, RATINGS), keep: pick(s.keep, ['yes', 'no']) })),
  }));
  const a = b.answers || {};
  const answers = Object.fromEntries(['q2', 'q3', 'q4', 'q5', 'q6', 'q7'].map(k => [k, t(a[k], 8000)]));
  const proposed = (Array.isArray(b.proposed) ? b.proposed : []).slice(0, 10).map(p => ({
    number: t(p.number, 6), text: t(p.text, 2000), kind: pick(p.kind, ['new', 'modified']),
    steps: (Array.isArray(p.steps) ? p.steps : []).slice(0, 8).map(s => ({ label: t(s.label, 6), text: t(s.text, 1000), kind: pick(s.kind, ['new', 'modified']) })),
  })).filter(p => p.text.trim());
  return { details, outcomes, answers, proposed };
}

// What's missing before anyone signs ([] = ready). NYC: "All questions must
// be answered", or the report is returned.
function missingForSigning(r) {
  const d = r.details || {};
  const out = [];
  if (!d.interventionist_phone) out.push('Your direct phone number');
  if (!d.languages) out.push('The language(s) used in sessions');
  if (!d.authorized_frequency) out.push('The authorized frequency');
  if (!d.start_date) out.push('The date you started working with this child');
  if (!d.delivery) out.push('How services were delivered');
  if (!d.locations) out.push('Where services were delivered');
  if (d.parent_participated !== true && d.parent_participated !== false) out.push('Whether a parent took part in sessions');
  if (!(d.comm_methods || []).length) out.push('How you share information with the family');
  if ((d.comm_methods || []).includes('other') && !d.comm_other) out.push('Describe the "Other" way you share information');
  if (!d.comm_frequency) out.push('How often information is shared');
  if ((d.at_using || d.at_requested) && !d.at_details) out.push('The assistive technology device and how it helps');
  const outcomes = r.outcomes || [];
  if (!outcomes.length) out.push('The IFSP outcomes (add them on the IFSP tab first)');
  for (const o of outcomes) {
    if (!o.rating || !o.keep) out.push(`Outcome ${o.number}: progress and keep / remove`);
    if (o.at_ifsp === false && !o.change_note) out.push(`Outcome ${o.number}: when and why it changed`);
    for (const s of o.steps || []) if (!s.rating || !s.keep) out.push(`Step ${s.label}: progress and keep Y / N`);
  }
  const a = r.answers || {};
  const q = { q2: 'Question 2 (outcomes not addressed; "None" if all were)', q3: 'Question 3 (what worked)', q4: 'Question 4 (changes made)', q5: 'Question 5 (collaboration)', q6: 'Question 6 (overall progress)', q7: 'Question 7 (next 6 months)' };
  for (const [k, label] of Object.entries(q)) if (!String(a[k] || '').trim()) out.push(label);
  if (!(r.proposed || []).length && !d.proposed_none) out.push('Question 8: propose new or modified outcomes, or tick "None proposed"');
  return out;
}

// A report's stage for lists.
function reportStatus(r) {
  if (!r) return 'not_started';
  if (r.sent_on) return 'sent';
  if (r.office_status === 'approved') return 'approved';
  if (r.office_status === 'returned') return 'returned';
  if (r.provider_signed_at && r.parent_signed_at) return r.supervisor_name && !r.supervisor_signed_at ? 'needs_supervisor' : 'to_approve';
  if (r.provider_signed_at) return 'needs_parent';
  if (r.parent_signed_at) return 'needs_provider';
  return 'draft';
}

module.exports = {
  RATINGS, COMM_METHODS, DELIVERY, SHOW_FROM_DAYS, GAP_SESSIONS,
  reportTypeOf, dueDateOf, gapsText, prefill, cleanDraft, missingForSigning, reportStatus,
};
