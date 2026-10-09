// Builds an EI-Hub 837P claim file (ASC X12 005010X222A1) following the
// state's EI-Hub 5010 837P Companion Guide v5.0.0 (ei-hub/ folder, not in
// git). One interchange (ISA/IEA), one group (GS/GE) and one transaction
// (ST/SE) -- the guide wants an ST/SE per municipality, and every child is in
// New York City for now (routes/eiHub.js refuses anything else). Each claim
// (CLM) is one session; each 15 minutes is a service line with 1 unit.
//
// Pure function: routes/eiHub.js gathers and checks the data first.

// Delimiters. The guide contradicts itself on the component separator (ISA16
// says "~", its delimiter table "|", its examples ":"); ":" is what its
// examples and X12 practice use. The first test file's 999 will confirm.
const E = '*';
const C = ':';
const REP = '^';
const SEG = '~';

// Upper case (ISA rule for the whole file), and nothing that could be read as
// a delimiter.
const clean = (v, max) => String(v ?? '').toUpperCase().replace(/[*:~^|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const pad = (v, n) => String(v).padEnd(n, ' ').slice(0, n);
const num = (v) => String(v).replace(/\D/g, '');
const money = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
const ymd = (d) => String(d).slice(0, 10).replace(/-/g, '');
const hhmm = (t) => String(t).slice(0, 5).replace(':', '');

// "Ava Brown" -> first AVA, last BROWN; "Jackson De Jesus" -> JACKSON / DE JESUS.
// EI-Hub matches the first 4 characters of each against its record.
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || parts[0] || '' };
}

// Spreads a visit's charge across its lines, cents left over on the last.
function splitCharge(total, lines) {
  const cents = Math.round(total * 100);
  const each = Math.floor(cents / lines);
  return Array.from({ length: lines }, (_, i) => (i === lines - 1 ? cents - each * (lines - 1) : each) / 100);
}

/**
 * @param {object} p
 *   agency   { agency_name, npi, tax_id, address_line1, address_line2, city, state, zip, contact_name, contact_phone, contact_email }
 *   control  positive integer, unique per file (ISA13 / GS06)
 *   invoice  the invoice number (BHT03), unique forever
 *   test     true for a test file (ISA15 "T")
 *   now      Date
 *   municipality { name: 'New York City', code: '70' }
 *   claims   [{ claim_number, child: { first, last, id, dob, sex, address_line1, address_line2, city, state, zip, mrn },
 *              diagnoses: ['F80.2'], authorization, visit_type: 'CV1'|'CV2', start_time, end_time, date,
 *              place_of_service: '11'|'12', referring: { last, first, npi, organization } | null,
 *              rendering: { last, first, npi }, lines: [{ code, charge }] }]
 */
function build837(p) {
  const { agency, control, invoice, test, now, municipality, claims } = p;
  const segs = [];
  const add = (...parts) => {
    // Trailing empty elements are dropped, as X12 expects.
    while (parts.length > 1 && (parts[parts.length - 1] === '' || parts[parts.length - 1] == null)) parts.pop();
    segs.push(parts.map(x => (x == null ? '' : x)).join(E));
  };
  const date8 = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const time4 = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const ctl9 = String(control).padStart(9, '0');
  const submitter = num(agency.tax_id);
  const payerName = clean(`${municipality.name} - Early Intervention`, 60);

  // Envelope.
  const isa = ['ISA', '00', pad('', 10), '00', pad('', 10), 'ZZ', pad(submitter, 15), 'ZZ', pad('EIHUB', 15),
    date8.slice(2), time4, REP, '00501', ctl9, '1', test ? 'T' : 'P', C].join(E);
  add('GS', 'HC', submitter, 'EIHUB', date8, time4, String(control), 'X', '005010X222A1');
  const stIndex = segs.length;
  const st02 = String(control).padStart(4, '0').slice(-9);
  add('ST', '837', st02, '005010X222A1');
  add('BHT', '0019', '00', clean(invoice, 50), date8, time4, 'CH');

  // 1000A submitter, 1000B receiver.
  add('NM1', '41', '2', clean(agency.agency_name, 60), '', '', '', '', '46', submitter);
  const per = ['PER', 'IC', clean(agency.contact_name, 60)];
  if (agency.contact_phone) per.push('TE', num(agency.contact_phone));
  if (agency.contact_email) per.push('EM', String(agency.contact_email).trim().toUpperCase().slice(0, 256));
  add(...per);
  add('NM1', '40', '2', payerName, '', '', '', '', '46', municipality.code);

  // 2000A / 2010AA billing provider.
  add('HL', '1', '', '20', '1');
  add('NM1', '85', '2', clean(agency.agency_name, 60), '', '', '', '', 'XX', num(agency.npi));
  add('N3', clean(agency.address_line1, 55), clean(agency.address_line2, 55));
  add('N4', clean(agency.city, 30), clean(agency.state, 2), num(agency.zip));
  add('REF', 'EI', submitter);

  // One subscriber level per claim (the child is the subscriber; no 2000C).
  let hl = 1;
  for (const c of claims) {
    hl += 1;
    add('HL', String(hl), '1', '22', '0');
    add('SBR', 'P', '18', '', '', '', '', '', '', 'OF');
    add('NM1', 'IL', '1', clean(c.child.last, 60), clean(c.child.first, 35), '', '', '', 'MI', clean(c.child.id, 80));
    add('N3', clean(c.child.address_line1, 55), clean(c.child.address_line2, 55));
    add('N4', clean(c.child.city, 30), clean(c.child.state, 2), num(c.child.zip));
    add('DMG', 'D8', ymd(c.child.dob), c.child.sex);
    add('NM1', 'PR', '2', payerName, '', '', '', '', 'PI', municipality.code);

    // 2300 claim.
    const total = c.lines.reduce((t, l) => t + l.charge, 0);
    add('CLM', clean(c.claim_number, 38), money(total), '', '', [c.place_of_service, 'B', '1'].join(C), 'Y', 'C', 'N', 'Y', 'P');
    add('REF', 'G1', clean(c.authorization, 30));
    if (c.child.mrn) add('REF', 'EA', clean(c.child.mrn, 50));
    add('NTE', 'ADD', `${c.visit_type}-${hhmm(c.start_time)}-${hhmm(c.end_time)}`);
    add('HI', ...c.diagnoses.slice(0, 12).map((d, i) => [i === 0 ? 'ABK' : 'ABF', d.replace('.', '').toUpperCase()].join(C)));
    if (c.referring) {
      if (c.referring.organization || !c.referring.first) {
        add('NM1', 'DN', '2', clean(c.referring.last, 60), '', '', '', '', 'XX', num(c.referring.npi));
      } else {
        add('NM1', 'DN', '1', clean(c.referring.last, 60), clean(c.referring.first, 35), '', '', '', 'XX', num(c.referring.npi));
      }
    }
    add('NM1', '82', '1', clean(c.rendering.last, 60), clean(c.rendering.first, 35), '', '', '', 'XX', num(c.rendering.npi));
    // 2310C service facility: required except in the child's home. Office
    // sessions are at the agency.
    if (c.place_of_service === '11') {
      add('NM1', '77', '2', clean(agency.agency_name, 60), '', '', '', '', 'XX', num(agency.npi));
      add('N3', clean(agency.address_line1, 55), clean(agency.address_line2, 55));
      add('N4', clean(agency.city, 30), clean(agency.state, 2), num(agency.zip));
    }

    // 2400 service lines.
    c.lines.forEach((l, i) => {
      add('LX', String(i + 1));
      add('SV1', ['HC', l.code].join(C), money(l.charge), 'UN', '1', '', '', '1');
      add('DTP', '472', 'D8', ymd(c.date));
      add('REF', '6R', clean(`${c.claim_number}-${i + 1}`, 50));
    });
  }

  add('SE', String(segs.length - stIndex + 1), st02);
  add('GE', '1', String(control));
  add('IEA', '1', ctl9);
  return [isa, ...segs].join(SEG) + SEG;
}

module.exports = { build837, splitName, splitCharge };
