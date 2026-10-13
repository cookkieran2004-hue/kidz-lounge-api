// Power Forms (Kieran, Oct 2026; routes/powerForms.js): what a form can hold
// and how answers are checked. A form is a list of fields:
//   { id, type, label, help, required, options, chart_field, default }
// `default` is the answer the form starts with (the parent can change it),
// e.g. boxes the office ticks before sending (Kieran, Oct 2026).
// `prefill` fills a question in from the patient's chart (PREFILL) when the
// parent opens the form; the parent can still change it.
// `chart_field` links a field to a patient column (CHART_FIELDS): the
// parent's answer is then offered to staff as a change to that column, never
// saved on its own ("staff review first").

const crypto = require('crypto');

// Plain names, as people building a form expect them.
const TYPES = {
  text: 'Short answer',
  textarea: 'Paragraph',
  choice: 'Multiple choice',
  checkboxes: 'Checkboxes',
  yesno: 'Yes / No',
  date: 'Date',
  phone: 'Phone number',
  email: 'Email',
  signature: 'Signature',
  heading: 'Section heading',
};

// Patient columns a field may update, and the field types that fit each.
const CHART_FIELDS = {
  Parent_Name: { label: 'Parent name', types: ['text'] },
  Relationship_To_Patient: { label: 'Relationship to patient', types: ['text', 'choice'] },
  Parent_Phone: { label: 'Parent phone', types: ['phone'] },
  Parent_Email: { label: 'Parent email', types: ['email'] },
  Allergies: { label: 'Allergies', types: ['text', 'textarea'] },
  Immunizations: { label: 'Immunizations', types: ['text', 'textarea'] },
  Picture_Consent: { label: 'Picture consent', types: ['yesno'] },
};

// What a question can be filled in from (Kieran, Oct 2026: "autofill the
// patient's saved info"), and the field types that fit each. Only sent to
// the parent after the child's date of birth is confirmed.
const PREFILL = {
  child_name: { label: "Child's full name", types: ['text'] },
  child_first: { label: "Child's first name", types: ['text'] },
  child_last: { label: "Child's last name", types: ['text'] },
  child_dob: { label: "Child's date of birth", types: ['date'] },
  ei_number: { label: 'ID # (EI child ID)', types: ['text'] },
  address: { label: 'Street address', types: ['text', 'textarea'] },
  address_line2: { label: 'Apt / address line 2', types: ['text'] },
  city: { label: 'City', types: ['text'] },
  state: { label: 'State', types: ['text'] },
  zip: { label: 'Zip code', types: ['text'] },
  parent_name: { label: 'Parent name', types: ['text'] },
  parent_phone: { label: 'Parent phone', types: ['phone'] },
  parent_email: { label: 'Parent email', types: ['email'] },
  relationship: { label: 'Relationship to patient', types: ['text'] },
  today: { label: "Today's date", types: ['date'] },
};
const STATES = { NY: 'New York', NJ: 'New Jersey', CT: 'Connecticut', PA: 'Pennsylvania' };
function prefillValue(key, p) {
  const name = String(p.Name || '').trim().split(/\s+/).filter(Boolean);
  const v = {
    child_name: name.join(' '),
    child_first: name[0],
    child_last: name.slice(1).join(' '),
    child_dob: p.Date_of_Birth ? String(p.Date_of_Birth).slice(0, 10) : null,
    ei_number: p.ID_Number,
    address: p.address_line1,
    address_line2: p.address_line2,
    city: p.city,
    state: p.state ? (STATES[String(p.state).toUpperCase()] || p.state) : null,
    zip: p.zip ? String(p.zip).replace(/^(\d{5})(\d{4})$/, '$1-$2') : null,
    parent_name: p.Parent_Name,
    parent_phone: p.Parent_Phone ? PHONE(p.Parent_Phone) : null,
    parent_email: p.Parent_Email,
    relationship: p.Relationship_To_Patient,
    today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  }[key];
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}
// The form's fields with the patient's saved details as starting answers.
function withPatient(fields, patient) {
  if (!patient) return fields;
  return fields.map(f => {
    const v = f.prefill ? prefillValue(f.prefill, patient) : null;
    return v ? { ...f, default: v } : f;
  });
}

const MAX_FIELDS = 100;
const text = (v, max) => String(v ?? '').trim().slice(0, max);

// A template from the builder -> { values } or { error }.
function cleanTemplate(b) {
  const name = text(b.name, 120);
  if (!name) return { error: 'Give the form a name.' };
  // Policies and letters can be long (Initial Clearance Forms, Oct 2026).
  const intro = text(b.intro, 12000) || null;
  const raw = Array.isArray(b.fields) ? b.fields : [];
  if (!raw.length) return { error: 'Add at least one field.' };
  if (raw.length > MAX_FIELDS) return { error: `A form can have up to ${MAX_FIELDS} fields.` };
  const fields = [];
  const ids = new Set();
  const linked = new Set();
  for (const [i, f] of raw.entries()) {
    const n = i + 1;
    const type = String(f?.type || '');
    if (!TYPES[type]) return { error: `Field ${n}: choose what kind of field it is.` };
    const label = text(f.label, 300);
    if (!label) return { error: `Field ${n}: it needs a label (the question or heading).` };
    let id = /^[a-z0-9_-]{4,40}$/i.test(String(f.id || '')) ? String(f.id) : `f${crypto.randomBytes(5).toString('hex')}`;
    if (ids.has(id)) id = `f${crypto.randomBytes(5).toString('hex')}`;
    ids.add(id);
    const field = { id, type, label, help: text(f.help, 6000) || null, required: type !== 'heading' && !!f.required };
    if (type === 'choice' || type === 'checkboxes') {
      const options = [...new Set((Array.isArray(f.options) ? f.options : []).map(o => text(o, 200)).filter(Boolean))];
      if (options.length < 2) return { error: `Field ${n} ("${label}"): give at least two choices.` };
      if (options.length > 50) return { error: `Field ${n} ("${label}"): up to 50 choices.` };
      field.options = options;
    }
    const d = f.default;
    if (d !== undefined && d !== null && d !== '' && !(Array.isArray(d) && !d.length)) {
      if (type === 'text' || type === 'email') field.default = text(d, 500) || undefined;
      else if (type === 'textarea') field.default = text(d, 5000) || undefined;
      else if (type === 'phone') field.default = PHONE(d) || undefined;
      else if (type === 'yesno') field.default = ['yes', 'no'].includes(String(d)) ? String(d) : undefined;
      else if (type === 'choice') {
        if (!field.options.includes(String(d))) return { error: `Field ${n} ("${label}"): the answer it starts with must be one of its choices.` };
        field.default = String(d);
      } else if (type === 'checkboxes') {
        const list = field.options.filter(o => (Array.isArray(d) ? d : [d]).map(String).includes(o));
        if (list.length) field.default = list;
      }
      if (field.default === undefined) delete field.default;
    }
    if (f.prefill) {
      const pk = PREFILL[f.prefill];
      if (!pk) return { error: `Field ${n} ("${label}"): it can't be filled in from that.` };
      if (!pk.types.includes(type)) return { error: `Field ${n} ("${label}"): ${pk.label} needs a ${pk.types.map(t => TYPES[t]).join(' or ')} question.` };
      field.prefill = f.prefill;
    }
    if (f.chart_field) {
      const cf = CHART_FIELDS[f.chart_field];
      if (!cf) return { error: `Field ${n} ("${label}"): that chart field can't be updated by a form.` };
      if (!cf.types.includes(type)) return { error: `Field ${n} ("${label}"): ${cf.label} needs a ${cf.types.map(t => TYPES[t]).join(' or ')} field.` };
      if (linked.has(f.chart_field)) return { error: `Two fields update ${cf.label}. Link it to one field only.` };
      linked.add(f.chart_field);
      field.chart_field = f.chart_field;
    }
    fields.push(field);
  }
  return { values: { name, intro, fields } };
}

const PHONE = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_SIGNATURE = 300000; // a drawn signature as a PNG data URL

// A parent's answers -> { answers } or { error, field } (field id).
function cleanAnswers(fields, raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const answers = {};
  for (const f of fields) {
    if (f.type === 'heading') continue;
    const v = given[f.id];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
      || (f.type === 'signature' && !(v && (String(v.name || '').trim() || v.image)));
    if (empty) {
      if (f.required) return { error: `Please answer "${f.label}".`, field: f.id };
      continue;
    }
    const bad = (msg) => ({ error: `"${f.label}": ${msg}`, field: f.id });
    if (f.type === 'text') answers[f.id] = text(v, 500);
    else if (f.type === 'textarea') answers[f.id] = text(v, 5000);
    else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return bad('enter a date.');
      answers[f.id] = String(v);
    } else if (f.type === 'phone') {
      const p = PHONE(v);
      if (!p) return bad('enter a 10-digit phone number.');
      answers[f.id] = p;
    } else if (f.type === 'email') {
      const e = text(v, 200);
      if (!EMAIL.test(e)) return bad('enter a valid email address.');
      answers[f.id] = e;
    } else if (f.type === 'choice') {
      if (!f.options.includes(String(v))) return bad('choose one of the options.');
      answers[f.id] = String(v);
    } else if (f.type === 'checkboxes') {
      const list = (Array.isArray(v) ? v : [v]).map(String);
      if (list.some(x => !f.options.includes(x))) return bad('choose from the options.');
      answers[f.id] = f.options.filter(o => list.includes(o));
    } else if (f.type === 'yesno') {
      if (!['yes', 'no'].includes(String(v))) return bad('choose Yes or No.');
      answers[f.id] = String(v);
    } else if (f.type === 'signature') {
      const name = text(v.name, 120);
      const image = typeof v.image === 'string' ? v.image : null;
      if (!name) return bad('type your full name.');
      if (!image || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > MAX_SIGNATURE) return bad('please sign in the box.');
      answers[f.id] = { name, image, signed_at: new Date().toISOString() };
    }
  }
  return { answers };
}

// What the answers would change on the chart: one entry per linked field
// that was answered and differs from the patient's current value.
function chartChanges(fields, answers, patient) {
  const out = [];
  for (const f of fields) {
    if (!f.chart_field || answers[f.id] === undefined) continue;
    const cf = CHART_FIELDS[f.chart_field];
    let to = answers[f.id];
    let from = patient[f.chart_field];
    if (f.chart_field === 'Picture_Consent') {
      to = to === 'yes';
      from = from === true ? true : from === false ? false : null;
    }
    const same = String(from ?? '').trim().toLowerCase() === String(to ?? '').trim().toLowerCase();
    if (same) continue;
    out.push({ key: f.chart_field, label: cf.label, from: from ?? null, to, field_id: f.id });
  }
  return out;
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

module.exports = { TYPES, CHART_FIELDS, PREFILL, withPatient, cleanTemplate, cleanAnswers, chartChanges, hashToken, newToken };
