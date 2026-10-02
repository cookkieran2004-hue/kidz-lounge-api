// Staff roles and what each may do -- the one place that decides.
//
//   staff      Their own schedule, time off, tasks and profile.
//   reception  Everything an admin can do outside the Admin area
//              (managing anyone's schedule, OOO, patients, tasks),
//              but not the Admin area itself.
//   admin      Everything.
//   developer  Everything an admin can, but never gets the system's
//              patient-related tasks (RX / IFSP deadlines, reports).
//
// "Admin area" = what the frontend's Admin page manages: staff accounts
// and roles, providers, time-off approvals and balances, office hours and
// closures, contracted hours / schedule changes, other people's
// credentials. Checked here on the server as well as hidden in the menu.

const ROLES = ['staff', 'reception', 'admin', 'developer'];

// Admin-level actions outside the Admin area.
const canManage = (user) => ['reception', 'admin', 'developer'].includes(user?.role);
// The Admin area.
const canAdminister = (user) => ['admin', 'developer'].includes(user?.role);
// Who the system's patient-related tasks (RX, IFSP, reports) can go to.
const getsPatientTasks = (role) => role !== 'developer';
// Who gets a patient's automated tasks when no case manager is linked.
// Developers can't be a patient's case manager either -- being one would
// route that patient's RX / IFSP tasks to them.
const canCaseManage = (role) => role !== 'developer';
// The HIPAA audit log (routes/auditLog.js): Developers only.
const canViewAuditLog = (user) => user?.role === 'developer';
const PATIENT_TASK_FALLBACK_ROLES = ['admin', 'reception'];

module.exports = { ROLES, canManage, canAdminister, getsPatientTasks, canCaseManage, canViewAuditLog, PATIENT_TASK_FALLBACK_ROLES };
