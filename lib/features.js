// Optional features switched on per clinic (Oct 2026). FEATURES on the
// Lambda is a comma-separated list, e.g. "mandates". Not set = none, so a
// clinic only gets a feature when its own setting names it -- the same code
// runs everywhere (clinic-platform template.yaml sets it per clinic; Kieran
// flips it). The frontend has a matching flag in src/brands/<clinic>.js.
//
//   mandates   Billing: month overview, mandates, needs attention, the EI
//              child-absence reason and the 4-absences-in-a-row task
//              (routes/billing.js, lib/mandates.js; PedsDesk first).
const enabled = () => new Set(String(process.env.FEATURES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const featureOn = (name) => enabled().has(String(name).toLowerCase());

module.exports = { featureOn };
