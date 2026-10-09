// Fixed lists for EI-Hub 837P billing (Oct 2026), from the state's EI-Hub
// 5010 837P Companion Guide and the clinic's code sheets (ei-hub/ folder,
// not in git: the guides are PCG confidential).

// CPT / HCPCS codes each discipline may bill, one per 15 minutes (speech is
// "not timed": one line per session for now). The clinic's code sheets.
// SI bills H2019 per 15 minutes (two for a half hour; Kieran, Oct 2026).
const ALLOWED_CODES = {
  OT: [
    { code: '97530', label: 'Functional therapy' },
    { code: '97533', label: 'Sensory integration' },
    { code: '97112', label: 'Neuromuscular training' },
    { code: '97535', label: 'ADL training' },
    { code: '97129', label: 'Cognitive (first 15 min)' },
    { code: '97130', label: 'Cognitive (each additional 15 min)' },
    { code: 'T1027', label: 'Family training' },
  ],
  PT: [
    { code: '97530', label: 'Therapeutic activities' },
    { code: '97116', label: 'Gait training' },
    { code: '97140', label: 'Manual therapy' },
    { code: '97110', label: 'Therapeutic exercise' },
    { code: '97112', label: 'Neuromuscular re-education' },
  ],
  ST: [
    { code: '92507', label: 'Speech therapy' },
    { code: '92526', label: 'Feeding therapy' },
  ],
  SI: [
    { code: 'H2019', label: 'Special instruction' },
  ],
};

// Municipality (payer) codes, companion guide Appendix A. The clinic's
// children are all New York City (70) for now.
const COUNTY_CODES = {
  Albany: '01', Allegany: '02', Broome: '03', Cattaraugus: '04', Cayuga: '05', Chautauqua: '06', Chemung: '07',
  Chenango: '08', Clinton: '09', Columbia: '10', Cortland: '11', Delaware: '12', Dutchess: '13', Erie: '14', Essex: '15',
  Franklin: '16', Fulton: '17', Genesee: '18', Greene: '19', Hamilton: '20', Herkimer: '21', Jefferson: '22', Lewis: '24',
  Livingston: '25', Madison: '26', Monroe: '27', Montgomery: '28', Nassau: '29', Niagara: '31', 'New York City': '70',
  Oneida: '32', Onondaga: '33', Ontario: '34', Orange: '35', Orleans: '36', Oswego: '37', Otsego: '38', Putnam: '39',
  Rensselaer: '41', Rockland: '43', 'St. Lawrence': '44', Saratoga: '45', Schenectady: '46', Schoharie: '47',
  Schuyler: '48', Seneca: '49', Steuben: '50', Suffolk: '51', Sullivan: '52', Tioga: '53', Tompkins: '54', Ulster: '55',
  Warren: '56', Washington: '57', Wayne: '58', Westchester: '59', Wyoming: '60', Yates: '61',
};

// An NPI is 10 digits with a Luhn check digit over "80840" + the first 9.
function validNpi(value) {
  const npi = String(value || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`.split('').map(Number);
  let sum = 0;
  for (let i = digits.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = digits[i];
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

// ICD-10-CM: letter, digit, then a digit or letter, then up to 4 more after
// an optional dot. Stored with the dot (F80.2); the claim drops it.
function normalizeIcd10(value) {
  const raw = String(value || '').toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  const m = raw.match(/^([A-Z]\d[0-9A-Z])\.?([0-9A-Z]{0,4})$/);
  if (!m) return undefined; // invalid
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

// How many claim lines a session gets: one per 15 minutes (1 unit each),
// except speech, which is "not timed" and bills one line per session for now
// (a new state standard will move it to two -- then add ST here).
const TIMED = new Set(['OT', 'PT', 'SI']);
function linesFor(service, minutes) {
  if (!TIMED.has(service)) return 1;
  return Math.max(1, Math.round((Number(minutes) || 30) / 15));
}

// The codes on a session's lines: an override saved for that session, else
// the provider's defaults repeated in order (OT 97530, 97533, 97530, ...).
function codesFor(service, minutes, defaults, override) {
  if (Array.isArray(override) && override.length) return override;
  const base = (defaults && defaults[service]) || [];
  if (!base.length) return [];
  return Array.from({ length: linesFor(service, minutes) }, (_, i) => base[i % base.length]);
}

// New York City visit rates, effective 10/1/2024 (ei-hub/service_rates.pdf).
// A visit of 60 minutes or more is "extended". Place of service 11 (office)
// is facility based; 12 (home, which also covers school / community) is home
// and community based. The billed charge is the visit rate, spread across
// the session's lines.
const NYC_RATES = {
  therapy: { basic: 83.78, extended: 116.66, facility: 66.81 }, // OT, PT, ST
  other: { basic: 79.54, extended: 111.35, facility: 63.63 },   // SI
};
function visitRate(service, minutes, placeOfService) {
  const r = ['OT', 'PT', 'ST'].includes(service) ? NYC_RATES.therapy : NYC_RATES.other;
  if (placeOfService === '11') return r.facility;
  return (Number(minutes) || 0) >= 60 ? r.extended : r.basic;
}

module.exports = { ALLOWED_CODES, COUNTY_CODES, validNpi, normalizeIcd10, linesFor, codesFor, visitRate };
