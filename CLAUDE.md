# kidz-lounge-api

Backend for Kidz Lounge, a staff-only scheduling and patient-management app for a pediatric therapy clinic. It is one AWS Lambda (`kidz-lounge-api`, region **us-east-2**) behind an API Gateway HTTP API, backed by Postgres (RDS). The frontend lives in the sibling repo `../kidz-lounge`, and one-off DB scripts live in `../kidz-lounge-scripts` (not a git repo).

## Commands

- No build, test, or lint setup. Plain CommonJS on Node 20. Check that a change loads with `node -e "require('./index.js')"`.
- Deploy: pushing to `main` runs `.github/workflows/deploy.yml`, which copies `index.js`, `lib/`, `routes/` and the package files into `dist/`, runs `npm ci --omit=dev`, and deploys to Lambda through OIDC. **Pushing to main is a production deploy.** Watch the result with `curl -s "https://api.github.com/repos/cookkieran2004-hue/kidz-lounge-api/actions/runs?per_page=5"` (the `gh` CLI isn't installed).
- A new top-level file or folder is not deployed unless you add it to the workflow's "Package function" step. New files under `lib/` or `routes/` are picked up automatically.
- `node_modules/` is committed and there's no `.gitignore`. The deploy runs its own `npm ci`, so the committed copy isn't used.

## Architecture

- `index.js` is the only entry point, and it's kept thin:
  1. **Scheduled jobs** (`event.source === 'aws.events'`): `scheduledJobFor(event)` takes `event.job` (a rule with constant JSON input) or else the **name of the EventBridge rule** that fired it, so a trigger added from the Lambda console's "Add trigger" (which can only send the plain matched event) runs the job it's named after. See the jobs table below. Anything unrecognised runs the 72-hour chat cleanup.
  2. **Public routes:** `POST /auth/login` and `POST /support/tickets`. The support route also accepts a signed-in user.
  3. **JWT check** (12h tokens, `JWT_SECRET`). After that, **every request re-reads `role`, `provider_name`, `archived` and `must_reset_password` from `Staff`**, so use `currentUser` and never trust role claims from the token. Users with `must_reset_password` can only reach `/auth/me` and `/auth/set-password`.
  4. Each module in `ROUTE_MODULES` gets `handle(ctx)` in turn. The first non-null response wins. If none answers, the response is a 404.
- **Route modules** (`routes/*.js`) export `handle({ path, method, qs, body, db, currentUser, event })`. They match paths with `path === '...'` or `path.match(/^\/x\/[^/]+$/)`, return `json(status, body)` from `lib/http.js`, and return `null` when a request isn't theirs. Every route pattern must be unique across all modules. Uncaught errors become a 500 with `err.message`.
- **Authorization** is checked inline: `if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' })`. Roles are `admin` or everyone else. Sensitive staff-account changes also need `verifyAdminPassword` (the admin re-enters their own password). Endpoints that read "your own" data usually let an admin pass `?username=`.
- **DB:** use `getPool()` from `lib/db.js`, a shared pool with max 3 connections. For transactions, use `const client = await db.connect(); BEGIN/COMMIT/ROLLBACK; client.release()`, or `inTransaction` in `lib/ptoAccrual.js` / `routes/timeOff.js`. Postgres `date` columns come back as `'YYYY-MM-DD'` strings on purpose (type parser 1082). Keep dates as strings end to end.
- Env vars: `DB_HOST/PORT/USER/PASSWORD/NAME`, `JWT_SECRET`, `S3_BUCKET_NAME`. Patient documents go to S3 through presigned URLs (`routes/documents.js`).

## Scheduled jobs

Set up as EventBridge rules on the Lambda (us-east-2). A rule's **name** picks the job.

| Rule / job name | Schedule (UTC) | Code |
|---|---|---|
| `pto-weekly-accrual` | `cron(0 12 ? * SUN *)` | `lib/ptoAccrual.js` `runWeeklyPtoAccrual` |
| `time-off-accrual` | `cron(0 12 1 * ? *)` | `lib/timeOffAccrual.js` (monthly UPTO only) |
| `compliance-check` | daily, e.g. `cron(0 11 * * ? *)` | `lib/complianceCheck.js` |
| `chat-deletion` (any other name) | daily | 72-hour chat cleanup in `index.js` |

Every job must be safe to re-run: accrual jobs record what they've credited and skip it next time. Test a job from the Lambda console with `{"source":"aws.events","resources":["arn:aws:events:us-east-2:322768320070:rule/<job-name>"]}`.

## Time off (PTO / UPTO)

- **PTO** is earned **weekly**: every Sunday, 0.08h per estimated hour worked Monday-Friday of the week just ended (`lib/ptoAccrual.js`). Missed weeks are caught up, and a week is never credited twice (the ledger's unique index on `period_start`). A week spanning New Year is split so the carryover trim happens between the halves.
  - **Hours worked are estimated from the schedule** (`lib/workSchedule.js`; there are no timesheets).
    - **Providers:** contracted hours (`ProviderUsualSchedule` plus scheduled changes), minus office closures and approved PTO/UPTO/Unavailable/Other time, plus sessions outside scheduled hours. Lunch and meetings count as worked.
    - **A provider's day with no patients seen counts as 0.** A patient isn't seen if nothing is booked, or every session is Canceled, No Show, `*HOLD*`, or the "HOLD - see comments" placeholder patient.
    - **Everyone else** (no linked provider) is salaried: 8h a day (9-5), Monday-Friday.
  - **Balance cap:** accrual stops at a 120h balance.
  - **Year end:** on Dec 31 a PTO balance over 40h is cut to 40.
  - **Constants** (`PTO_RATE`, `PTO_BALANCE_CAP`, `PTO_CARRYOVER_MAX`, `POLICY_START = '2026-09-01'`) live in `lib/workSchedule.js`. The frontend reads them from `GET /time-off/policy`, so there's one source of truth.
- **UPTO** is a flat 40h/yr, 3.25h credited on the 1st of each month (`lib/timeOffAccrual.js`, which uses `last_accrued_month` to skip repeats).
- **What a request costs** is the scheduled hours it covers, not clock hours: a Mon-Fri week is 40h, not 104h. The cost is `chargeHoursFor` in `lib/workSchedule.js`, stored on the request as `charged_hours` (an estimate when filed, fixed at approval) so a refund matches exactly. `hoursBetween` (clock hours) survives only for older requests without `charged_hours`.
- **Two-week limit:** PTO in a row (this request plus adjacent PTO, bridging non-workdays) can't exceed 2 × the person's scheduled weekly hours (`consecutivePtoCheck`). Extra days go in as UPTO.
- **Changing an approved PTO/UPTO request** cancels the original immediately (hours refunded, blocks removed, row deleted) and files the change as a plain new request, with no `replaces_request_id`. Other types keep the linked "change request" flow, where the original stays until approval.
- **Negative balances are allowed** with an admin's approval. Employees are never blocked. An admin adding or changing time off gets a 409 `negativeBalance` warning and resends with `confirm_negative_balance: true`.
- **Ledger** (`TimeOffLedger`): every PTO/UPTO balance change goes through `adjustBalance` (lock the row, update, record `kind`, `hours`, and `details` such as the weekly day-by-day estimate).
  - **Deleting an approved request** removes its `used` entry instead of adding a refund (`removeUsage`). A refund is only written for old requests that have no entry.
  - `GET /time-off/ledger` works each row's displayed balance back from the current balance, so the history always adds up.
  - Only PTO/UPTO are ledgered. Pre-redesign request types (Vacation/Sick/Personal, still `is_balance_type`) adjust their retired balances without ledger entries.
- **Endpoints:** `GET /time-off/policy` (rates plus the person's weekly scheduled hours), `/time-off/ledger`, and `/time-off/estimate` (the cost of a span, for the request form).
- The one-time Sep 1 2026 reset (`../kidz-lounge-scripts/reset_time_off_2026_09_01.js`) has been applied. `recalculate_pto_weeks.js` re-credits past weeks after a rule change.

## Data model gotchas

- Tables and many columns are quoted mixed-case identifiers (`"Patients"`, `"Name"`, `"RX_Expiration"`, `"Case_Manager"`). Always quote them in SQL.
- **Providers are referenced by name, not id**, across `Appointments`, `Out_of_Office`, `RecurringSeries`, `OOO_RecurringSeries`, `Staff.provider_name`, `ProviderUsualSchedule` and `ProviderScheduleChanges`. Renames must go through `lib/providerNames.js` (`cascadeProviderRename` / `syncLinkedProvider`) inside a transaction. A provider linked to a staff account is always named after that person (preferred or first name, plus last name).
- **Providers' disciplines** (ST / OT / PT / SI) live in the free-text `Providers.specialty`, e.g. "ST" or "ST/OT". The frontend parses them for its filter chips.
- Appointments reference patients by `patient_name`.
- **Recurring appointments and OOO are virtual.** `RecurringSeries` / `OOO_RecurringSeries` rows are expanded when read by `lib/recurring.js` (`getMergedAppointments`, `getMergedOOO`). Every read path must go through the merge helpers.
  - Editing a single occurrence creates a real row with `exception_of_series_id` + `exception_occurrence_date`.
  - Deleting one creates a real row with `deleted = true`, which hides it and blocks regeneration.
  - Exception lookups are batched in one query per call. Don't reintroduce a query per series.
- **Case manager:** `case_manager_username` is the real link. `Case_Manager` is legacy display text, derived on the server (`resolveCaseManagerFields` in `routes/patients.js`). Automated tasks fall back to **all active admins** when no case manager is linked or the linked account is archived (`resolveCaseManagerAssignees` in `lib/utils.js`).
- **Compliance tasks** (`lib/complianceCheck.js`): RX expiring within 14 days and IFSP end dates go to the case manager. Report Date goes to the patient's current providers. Credentials expiring within 14 days go to the credential holder. Duplicates are blocked by (patient, deadline_type, deadline_date, assigned_to).
- **Staff phone** (`PUT /staff/me`) must be a US 10-digit number, stored as `(555) 555-5555`.
- **Names, not usernames:** anything user-facing that says who did something should use a display name (`displayNameFor` in `lib/utils.js`). `GET /staff/directory?include_archived=true` lets the frontend name people who have left.
- The support ticket inbox belongs to a single hardcoded user, `SUPPORT_OWNER = 'KJC135'` (`routes/support.js`, and mirrored in the frontend's `src/supportCount.js`).
- Partial updates: use `mergedField(body, key, existingRow)`. A missing key keeps the current value, and a key sent as `''` or `null` clears it.

## Migrations

- `migrations/YYYY-MM-DD_description.sql`. They must be idempotent (`IF NOT EXISTS`, "safe to run more than once").
- **Claude has no DB credentials.** Kieran runs them from `../kidz-lounge-scripts`:
  ```
  node run_sql_file.js ../kidz-lounge-api/migrations/<file>.sql
  ```
  with `DB_*` exported, using the values from the Lambda's environment variables. Give him the exact commands, plus a `node -e` check query to confirm the result.
- One-off data scripts go in `../kidz-lounge-scripts`. They require the API's `lib/` modules, run in **one transaction**, **dry-run by default** (print a `console.table` and roll back), and only commit with `--apply`. Guard against double runs.
- Code must keep working before its migration has been run: check whether the table or column exists and degrade gracefully. Cache only a **positive** result (see `hasLedgerTable`, `hasChargedColumn`), so a warm Lambda picks up the migration once it's run. The older helpers (`hasColumn`, `hasChangesTable`) cache "no" as well.
- The base schema isn't in the repo. Migrations only cover changes from 2026-09-25 onward.

## Testing

There's no test suite. For logic changes, write a throwaway script in the session scratchpad:
- **Pure functions:** call them directly (e.g. `lib/workSchedule.js`'s `estimateWeek` and `chargeForRequest`).
- **Jobs and routes:** pass a fake `db` whose `query(sql, params)` matches SQL with regexes and serves in-memory tables. `routes/*.js` `handle()` returns `{ statusCode, body }`, with `body` as a JSON string.

Show the results before shipping.

## Style

- Comments explain *why*, often at length, including past bugs the code prevents. Match that when changing behavior.
- 2-space indent, single quotes, semicolons, parameterized queries only (`$1, $2`).
- User-facing error messages are plain-English sentences, because staff read them directly in the UI. Say what to do next ("Request the extra days as UPTO instead").
- Commit messages: a short summary line, then a paragraph on what changed and why, ending with the `Co-Authored-By` trailer.
