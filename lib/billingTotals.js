// A billing sheet's payroll totals (Kieran, Oct 2026; reworked Oct 14, and
// Oct 15: EI Center and EI School are separate again), in 30-minute units:
// a 30-minute session is 1, 45 minutes 1.5, 60 minutes 2 (minutes / 30).
// Only sessions provided (marks X, M, E) count:
//   EI Center           EI sessions at a center (an office room, or offsite at a center)
//   EI School           EI sessions at a school
//   EI Home             EI sessions at home
//   DOE 30              every DOE session (30, 45 or 60 minutes)
//   Insurance           every row with a billing code (C-1 ... C-#), or
//                       still missing one (needs_code)
// A session that needs fixing before it counts (EI with no setting, DOE
// that isn't 30, 45 or 60 minutes) is listed in `missed` (the sheet's "Not
// counted"). Sessions with no program are in no total.
//
// Worked out here so the billing sheet, the month overview and the payroll
// export agree (routes/billing.js). The frontend's BillingPage.jsx keeps the
// same rules for clinics without the "mandates" feature: change both.
const COUNTED = ['X', 'M', 'E'];

// 'C' (an office room, or offsite at a center), 'S', 'H', or '' (no room,
// or an older offsite session with no setting). Same as routes/billing.js.
function settingOf(area) {
  const a = String(area || '').trim();
  if (!a) return '';
  const m = a.match(/^Offsite(?: \((Center|School|Home)\))?(?::|$)/i);
  if (!m) return 'C';
  return m[1] ? m[1][0].toUpperCase() : '';
}

const EMPTY = () => ({ ei_center: 0, ei_school: 0, ei_home: 0, doe: 0, insurance: 0, sessions: 0, missed: [] });

function unitTotals(rows) {
  const out = EMPTY();
  const miss = (r, day, e, reason) => out.missed.push({ patient_name: r.patient_name, day: Number(day), time: e.time, id: e.id, reason });
  for (const r of rows || []) {
    const pay = r.pay_group || r.group;
    const coded = r.needs_code || /^C-/.test(String(r.program || ''));
    for (const [day, entries] of Object.entries(r.days || {})) {
      for (const e of entries) {
        if (!COUNTED.includes(e.mark)) continue;
        out.sessions += 1;
        const minutes = Number(e.duration) || 30;
        const units = minutes / 30;
        if (pay === 'EI') {
          const setting = settingOf(e.room);
          if (setting === 'H') out.ei_home += units;
          else if (setting === 'S') out.ei_school += units;
          else if (setting === 'C') out.ei_center += units;
          else miss(r, day, e, 'EI, no setting (Center / School / Home)');
        } else if (pay === 'DOE') {
          if (minutes === 30 || minutes === 45 || minutes === 60) out.doe += units;
          else miss(r, day, e, `DOE, ${minutes} min (only 30, 45 and 60 count)`);
        } else if (coded) out.insurance += units;
      }
    }
  }
  out.missed.sort((a, b) => (a.day - b.day) || String(a.time).localeCompare(String(b.time)));
  return out;
}

// The unit totals, in the order the sheet, the overview and the export show them.
const TOTAL_COLUMNS = [
  ['ei_center', 'EI Center'], ['ei_school', 'EI School'], ['ei_home', 'EI Home'], ['doe', 'DOE 30'], ['insurance', 'Insurance'],
];

module.exports = { unitTotals, TOTAL_COLUMNS, COUNTED, settingOf, EMPTY };
