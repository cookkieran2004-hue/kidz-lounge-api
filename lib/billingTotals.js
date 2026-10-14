// A billing sheet's payroll totals (Kieran, Oct 2026), in 30-minute units:
// a 30-minute session is 1, 45 minutes 1.5, 60 minutes 2 (minutes / 30).
// Only sessions provided (marks X, M, E) count. EI splits by where it
// happened (an EI session with no setting is in neither EI total); DOE by
// length; Insurance (BCBS/Anthem, CIGNA, GHI, P, PP) and Other by the row's
// pay group; Outside hours across every program. A provided session no
// total picks up is listed in `missed` (the sheet's "Not counted").
//
// Worked out here so the billing sheet, the month overview and the payroll
// export agree (routes/billing.js). The frontend's BillingPage.jsx had the
// same rules before Oct 2026 and keeps them for clinics without the
// "mandates" feature.
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

const EMPTY = () => ({ ei_center_school: 0, ei_home: 0, doe_30: 0, doe_45: 0, doe_60: 0, insurance: 0, other: 0, outside_hours: 0, sessions: 0, missed: [] });

function unitTotals(rows) {
  const out = EMPTY();
  const miss = (r, day, e, reason) => out.missed.push({ patient_name: r.patient_name, day: Number(day), time: e.time, id: e.id, reason });
  for (const r of rows || []) {
    const pay = r.pay_group || r.group;
    for (const [day, entries] of Object.entries(r.days || {})) {
      for (const e of entries) {
        if (!COUNTED.includes(e.mark)) continue;
        out.sessions += 1;
        const minutes = Number(e.duration) || 30;
        const units = minutes / 30;
        if (e.outside_hours) out.outside_hours += units;
        if (pay === 'EI') {
          const setting = settingOf(e.room);
          if (setting === 'H') out.ei_home += units;
          else if (setting) out.ei_center_school += units;
          else miss(r, day, e, 'EI, no setting (Center / School / Home)');
        } else if (pay === 'DOE') {
          if (minutes === 45) out.doe_45 += units;
          else if (minutes === 60) out.doe_60 += units;
          else if (minutes === 30) out.doe_30 += units;
          else miss(r, day, e, `DOE, ${minutes} min (no total for that length)`);
        } else if (pay === 'Insurance') out.insurance += units;
        else out.other += units;
      }
    }
  }
  out.missed.sort((a, b) => (a.day - b.day) || String(a.time).localeCompare(String(b.time)));
  return out;
}

// The unit totals, in the order the sheet, the overview and the export show them.
const TOTAL_COLUMNS = [
  ['ei_center_school', 'EI Center & School'], ['ei_home', 'EI Home'],
  ['doe_30', 'DOE 30 min'], ['doe_45', 'DOE 45 min'], ['doe_60', 'DOE 60 min'],
  ['insurance', 'Insurance'], ['other', 'Other'], ['outside_hours', 'Outside hours'],
];

module.exports = { unitTotals, TOTAL_COLUMNS, COUNTED, settingOf, EMPTY };
