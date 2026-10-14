// Optional features switched on per clinic (Oct 2026). FEATURES on the
// Lambda is a comma-separated list, e.g. "ei". Not set = none, so a clinic
// only gets a feature when its own setting names it -- the same code runs
// everywhere (clinic-platform template.yaml sets it per clinic; Kieran
// flips it by code change). The frontend has a matching flag in
// src/brands/<clinic>.js.
//
//   ei   PedsDesk as the EMR for NYC Early Intervention agencies (session
//        notes, EI-Hub billing, authorizations / IFSPs, reports). PedsDesk
//        only; Kidz Lounge's Lambda doesn't set it.
const enabled = () => new Set(String(process.env.FEATURES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const featureOn = (name) => enabled().has(String(name).toLowerCase());

module.exports = { featureOn };
