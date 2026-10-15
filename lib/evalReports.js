// EI evaluation reports (the "ei" feature, PedsDesk only; Kieran, Oct 2026;
// migrations/2026-11-07_ei_compliance.sql, routes/evalReports.js).
//
// One report per evaluation appointment (Appointments.is_eval), with the
// parts NYS DOH requires of an EI evaluation report (Memo 2005-02 and the
// NYC evaluation report checklist): who evaluated and their qualifications,
// the type of evaluation, how it was done, the child's responses and
// whether the family felt they were typical, the child's status in all
// five developmental domains with strengths and needs, how clinical
// opinion was used, the instruments and scores, eligibility (with the
// diagnosed condition's ICD-10), recommendations and a summary. Locked once
// the evaluator signs; corrections are addenda. An evaluation takes this
// report instead of a session note.

const EVAL_TYPES = ['initial_mde', 'supplemental', 'other'];
const DOMAINS = ['physical', 'cognitive', 'communication', 'social_emotional', 'adaptive'];
const DOMAIN_LABEL = {
  physical: 'Physical (including vision, hearing and health)',
  cognitive: 'Cognitive',
  communication: 'Communication',
  social_emotional: 'Social-emotional',
  adaptive: 'Adaptive',
};
const ELIGIBILITY = ['delay', 'condition', 'not_eligible', 'na'];
// The agency's own target for writing up an evaluation (the 45-day IFSP
// timeline leaves little room): days after the evaluation.
const REPORT_DUE_DAYS = 10;

function addDays(s, n) { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dueDateOf = (evalDate) => (evalDate ? addDays(String(evalDate).slice(0, 10), REPORT_DUE_DAYS) : null);

const text = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

// Checks the evaluator's draft. Returns { details, instruments, domains }.
function cleanDraft(body) {
  const b = body || {};
  const d = b.details || {};
  const evaluators = (Array.isArray(d.evaluators) ? d.evaluators : []).slice(0, 6)
    .map(e => ({ name: text(e?.name, 120), title: text(e?.title, 120), qualifications: text(e?.qualifications, 300) }))
    .filter(e => e.name || e.title || e.qualifications);
  const details = {
    eval_type: EVAL_TYPES.includes(d.eval_type) ? d.eval_type : null,
    eval_type_other: text(d.eval_type_other, 200),
    evaluators,
    location: text(d.location, 200),
    language: text(d.language, 100),
    present: text(d.present, 300),
    referral_reason: text(d.referral_reason, 3000),
    history: text(d.history, 6000),
    process: text(d.process, 6000),
    child_response: text(d.child_response, 4000),
    typical: d.typical === true || d.typical === false ? d.typical : null,
    typical_note: text(d.typical_note, 2000),
    clinical_opinion: text(d.clinical_opinion, 4000),
    eligibility: ELIGIBILITY.includes(d.eligibility) ? d.eligibility : null,
    eligibility_detail: text(d.eligibility_detail, 3000),
    icd10: text(d.icd10, 100),
    recommendations: text(d.recommendations, 6000),
    summary: text(d.summary, 6000),
  };
  const instruments = (Array.isArray(b.instruments) ? b.instruments : []).slice(0, 20)
    .map(x => ({ name: text(x?.name, 200), area: text(x?.area, 200), score: text(x?.score, 300), notes: text(x?.notes, 1000) }))
    .filter(x => x.name || x.area || x.score);
  const domains = {};
  for (const k of DOMAINS) {
    const v = (b.domains || {})[k] || {};
    domains[k] = { status: text(v.status, 4000), strengths: text(v.strengths, 3000), needs: text(v.needs, 3000) };
  }
  return { details, instruments, domains };
}

// What's still missing before the evaluator can sign ([] = ready).
function missingForSigning(r) {
  const d = r?.details || {};
  const out = [];
  if (!d.eval_type) out.push('The type of evaluation');
  if (d.eval_type === 'other' && !d.eval_type_other) out.push('Which kind of evaluation ("Other")');
  if (!(d.evaluators || []).some(e => e.name && e.title && e.qualifications)) out.push("Each evaluator's name, title and qualifications");
  if (!d.process) out.push('How the evaluation was done (the assessment process)');
  if (!d.child_response) out.push("The child's responses to the evaluation");
  if (d.typical === null || d.typical === undefined) out.push("Whether the family felt the child's responses were typical");
  if (d.typical === false && !d.typical_note) out.push('How the responses were not typical');
  for (const k of DOMAINS) {
    const v = (r?.domains || {})[k] || {};
    if (!v.status) out.push(`Status: ${DOMAIN_LABEL[k]}`);
  }
  if (!(r?.instruments || []).some(x => x.name)) out.push('The instruments used (with scores)');
  if (!d.clinical_opinion) out.push('How informed clinical opinion was used');
  if (!d.eligibility) out.push('The eligibility finding');
  if (d.eligibility === 'condition' && !d.icd10) out.push('The diagnosed condition\'s ICD-10 code');
  if ((d.eligibility === 'delay' || d.eligibility === 'condition' || d.eligibility === 'not_eligible') && !d.eligibility_detail) out.push('The basis for the eligibility finding');
  if (!d.recommendations) out.push('Recommendations');
  if (!d.summary) out.push('Summary');
  return out;
}

function reportStatus(r, today) {
  if (!r || (!r.provider_signed_at && !Object.keys(r.details || {}).length)) return r?.eval_date && today && dueDateOf(r.eval_date) < today ? 'late' : 'none';
  if (!r.provider_signed_at) return 'draft';
  if (r.supervisor_name && !r.supervisor_signed_at) return 'needs_supervisor';
  return 'complete';
}

module.exports = { EVAL_TYPES, DOMAINS, DOMAIN_LABEL, ELIGIBILITY, REPORT_DUE_DAYS, dueDateOf, cleanDraft, missingForSigning, reportStatus };
