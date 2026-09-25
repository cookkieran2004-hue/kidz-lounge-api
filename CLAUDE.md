# kidz-lounge-api

Backend for Kidz Lounge, a staff-only scheduling and patient-management app for a pediatric therapy clinic. It is one AWS Lambda behind an API Gateway HTTP API, backed by Postgres. The frontend lives in the sibling repo `../kidz-lounge`.

## Commands

- No build, test, or lint setup. Plain CommonJS on Node 20.
- Deploy: pushing to `main` runs `.github/workflows/deploy.yml`, which copies `index.js`, `lib/`, `routes/` and the package files into `dist/`, runs `npm ci --omit=dev`, and deploys to Lambda through OIDC. **Pushing to main is a production deploy.**
- A new top-level file or folder is not deployed unless you add it to the workflow's "Package function" step.
- `node_modules/` is committed and there's no `.gitignore`. The deploy runs its own `npm ci`, so the committed copy isn't used.

## Architecture

- `index.js` is the only entry point, and it's kept thin:
  1. **EventBridge events** (`event.source === 'aws.events'`) are routed by `event.job`: `compliance-check` → `lib/complianceCheck.js`, `time-off-accrual` → `lib/timeOffAccrual.js`. Anything else runs the 72-hour chat cleanup.
  2. **Public routes:** `POST /auth/login` and `POST /support/tickets`. The support route also accepts a signed-in user.
  3. **JWT check** (12h tokens, `JWT_SECRET`). After that, **every request re-reads `role`, `provider_name`, `archived` and `must_reset_password` from `Staff`**, so use `currentUser` and never trust role claims from the token. Users with `must_reset_password` can only reach `/auth/me` and `/auth/set-password`.
  4. Each module in `ROUTE_MODULES` gets `handle(ctx)` in turn. The first non-null response wins. If none answers, the response is a 404.
- **Route modules** (`routes/*.js`) export `handle({ path, method, qs, body, db, currentUser, event })`. They match paths with `path === '...'` or `path.match(/^\/x\/[^/]+$/)`, return `json(status, body)` from `lib/http.js`, and return `null` when a request isn't theirs. Every route pattern must be unique across all modules. Uncaught errors become a 500 with `err.message`.
- **Authorization** is checked inline: `if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' })`. Roles are `admin` or everyone else. Sensitive staff-account changes also need `verifyAdminPassword` (the admin re-enters their own password).
- **DB:** use `getPool()` from `lib/db.js`, which is a shared pool with max 3 connections. For transactions, use `const client = await db.connect(); BEGIN/COMMIT/ROLLBACK; client.release()`. Postgres `date` columns come back as `'YYYY-MM-DD'` strings on purpose (type parser 1082). Keep dates as strings end to end.
- Env vars: `DB_HOST/PORT/USER/PASSWORD/NAME`, `JWT_SECRET`, `S3_BUCKET_NAME`. Patient documents go to S3 through presigned URLs (`routes/documents.js`).

## Data model gotchas

- Tables and many columns are quoted mixed-case identifiers (`"Patients"`, `"Name"`, `"RX_Expiration"`, `"Case_Manager"`). Always quote them in SQL.
- **Providers are referenced by name, not id**, across `Appointments`, `Out_of_Office`, `RecurringSeries`, `OOO_RecurringSeries`, `Staff.provider_name`, `ProviderUsualSchedule` and `ProviderScheduleChanges`. Renames must go through `lib/providerNames.js` (`cascadeProviderRename` / `syncLinkedProvider`) inside a transaction. A provider linked to a staff account is always named after that person (preferred or first name, plus last name).
- Appointments reference patients by `patient_name`.
- **Recurring appointments and OOO are virtual.** `RecurringSeries` / `OOO_RecurringSeries` rows are expanded when read by `lib/recurring.js` (`getMergedAppointments`, `getMergedOOO`). Editing a single occurrence creates a real row with `exception_of_series_id` + `exception_occurrence_date`. Deleting an occurrence creates a real row with `deleted = true`, which hides it and blocks regeneration. Every read path must go through the merge helpers.
- **Case manager:** `case_manager_username` is the real link. `Case_Manager` is legacy display text, derived on the server (`resolveCaseManagerFields` in `routes/patients.js`). Automated tasks fall back to **all active admins** when no case manager is linked or the linked account is archived (`resolveCaseManagerAssignees` in `lib/utils.js`).
- **Compliance tasks** (`lib/complianceCheck.js`, daily):
  - RX expiring within 14 days and IFSP end dates go to the case manager.
  - Report Date goes to the patient's current providers.
  - Expiring staff credentials go to the credential holder.
  - Duplicates are blocked by (patient, deadline_type, deadline_date, assigned_to).
- Time off is tracked in hours (`PTO` 80/yr, `UPTO` 40/yr), accrued monthly and prorated for new hires. `Lunch`, `Meeting`, `Unavailable` and `Other` don't affect the balance.
- The support ticket inbox belongs to a single hardcoded user, `SUPPORT_OWNER = 'KJC135'` (`routes/support.js`, and mirrored in the frontend's `src/supportCount.js`).
- Partial updates: use `mergedField(body, key, existingRow)`. A missing key keeps the current value, and a key sent as `''` or `null` clears it.

## Migrations

- `migrations/YYYY-MM-DD_description.sql`. They're run by hand against the DB (there's no runner) and must be idempotent (`IF NOT EXISTS`, "safe to run more than once").
- Code must keep working before its migration has been run. The pattern is to check once per cold start whether the table or column exists (`to_regclass(...)` or `information_schema.columns`), cache the promise, and degrade gracefully. See `hasAlertColumns` in `routes/patients.js`, `hasChangesTable` in `lib/scheduleChanges.js`, and `hasTable` in `lib/meetingAgendas.js`. New schema-dependent features should follow the same pattern.
- The base schema isn't in the repo. Migrations only cover changes from 2026-09-25 onward.

## Style

- Comments explain *why*, often at length, including past bugs the code prevents. Match that when changing behavior.
- 2-space indent, single quotes, semicolons, parameterized queries only (`$1, $2`).
- User-facing error messages are plain-English sentences, because staff read them directly in the UI.
