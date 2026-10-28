# Olive & Ember QR ordering

This project now uses **Firebase Realtime Database** for customer menu/table reads, staff access records, and dashboard reads/writes. The existing Firestore database is not configured by this app, and no Firestore data is copied or deleted.

Customers open `/?table=1` through `/?table=11` without a visible login. Firebase Anonymous Authentication associates customer sessions with orders. Staff sign in with Google. The configured Admin can grant or revoke staff access through the trusted backend. Staff grants are stored under `supervisorAccess/{emailKey}` and copied to `staffAccessByUid/{uid}` by the trusted backend after verifying the signed-in account email against the active grant. Realtime Database Rules use the UID mapping for order and manager reads, avoiding email-to-key conversion inside rules.

The Admin and Supervisor portals are role-specific views of the same Realtime Database records; orders are not copied into separate Admin and Supervisor collections. The Admin dashboard is identified from the configured verified Admin email so it can load read-only data even when the Functions emulator is offline. Staff role checks and Admin staff-access changes, along with order updates, still require the trusted Functions backend. Older records stored only in Firestore do not appear in these RTDB-backed views and are not synchronized automatically.

### Reconcile legacy Firestore staff access

If supervisor records still exist only in the legacy Firestore database, authenticate the Google Cloud CLI with an account that can read Firestore and write the project's Realtime Database. The migration reads only `supervisorAccess` and supervisor/manager entries in `users`; it never deletes or modifies Firestore records. It defaults to a dry run and skips records that conflict with existing RTDB access:

```powershell
gcloud auth application-default login
npm.cmd --prefix functions run migrate:staff-access
```

Review the summary, then apply additions that do not conflict:

```powershell
npm.cmd --prefix functions run migrate:staff-access -- --apply
```

If the dry run reports a conflict, compare the records in both databases first. Only when Firestore is confirmed as the authoritative record should an administrator explicitly overwrite conflicting RTDB entries:

```powershell
npm.cmd --prefix functions run migrate:staff-access -- --apply --overwrite-conflicts
```

The migration supports Gmail staff records with `supervisor` or `manager` roles and `active` or `revoked` status. It skips the configured Admin account and does not migrate Firestore orders, menu items, or tables.

## Realtime Database paths

- `/menuItems/{itemId}` — menu records with price stored as integer paise.
- `/tables/{tableId}` — table display number and active state.
- `/orders/{orderId}` — orders; protected reads are allowed for staff and the owning customer. Direct client writes are denied.
- `/orderRequests/{uid}/{requestId}` — idempotency records; clients cannot access them.
- `/users/{uid}` — legacy profile path, client writes denied.
- `/supervisorAccess/{emailKey}` — staff grant records. For RTDB-safe keys, email periods are replaced with commas; the original email stays in the record.
- `/staffAccessByUid/{uid}` — trusted-backend staff authorization mirror used by Realtime Database Rules; clients cannot write these records.
- `/visits/{visitId}` — visit metrics; writes are denied to clients.

## Firebase setup

1. Keep project `hotel-mangment-system-b4aa8` and its current Firebase web configuration in the ignored root `.env`.
2. In **Authentication → Sign-in method**, enable **Google** and **Anonymous**. Add `localhost`, `127.0.0.1` if used, and the Hosting domain to authorized domains.
3. Confirm Realtime Database is enabled in the `asia-southeast1` region. The root `.env.local` contains the supplied public database URL; `.env.example` documents the required setting.
4. In **Realtime Database → Rules**, publish the rules from `database.rules.json`. Admin operations require a Google-authenticated, verified token for `kathipavankumarreddy@gmail.com`. Other emails do not automatically become supervisors.
5. Realtime Database is a different product and data store from Firestore. No existing Firestore data is migrated by this code change.

### Admin and supervisor sign-in

The active app authorizes staff against Realtime Database, not legacy Firestore role documents. The Admin is explicitly configured as `kathipavankumarreddy@gmail.com` in the staff frontend and trusted Functions backend; a verified Google sign-in with that exact address receives the Admin role. Do not initialize Admin access by editing a database role record or by promoting the first person who signs in. If the owner account changes, update the configured address in both code locations through an owner-controlled code change, then rebuild/restart the app and backend.

An Admin grants or revokes supervisor/manager access from the staff dashboard. Grants are keyed by normalized email and mirrored to the verified account's UID by the trusted backend. A supervisor must use that same verified Google account. A supervisor cannot grant staff access or change their role. These role changes and order actions require the Functions backend; an Admin may still open the dashboard to inspect data while the backend is offline, but protected backend actions will not work.

If staff sign-in cannot contact the backend, the page now keeps the signed-in session and displays a retryable backend error instead of signing out and replacing it with a misleading supervisor-grant message. Use **Retry staff access** after starting the Functions backend. A genuine permission-denied response means the account's verified email is not the configured Admin address or does not have an active staff grant. Check the email in the signed-in Google account, the exact grant under `/supervisorAccess/{emailKey}`, and the Functions emulator/deployment logs. Do not change database rules to bypass the backend.

## Install

```powershell
npm.cmd install
npm.cmd --prefix functions install
```

## Safe local emulator setup

The local development commands below use the isolated Firebase project ID `demo-hotel-mangment-system-b4aa8` with Auth, Realtime Database, and Functions emulators. Emulator mode refuses a non-`demo-*` project ID; the Functions backend also refuses emulator startup unless the local Realtime Database emulator is configured. These commands do not connect to production RTDB or change production rules.

### Direct Google sign-in against Firebase

The staff portal uses Firebase's Google popup sign-in and prompts you to choose an account. For a real Google account, start the loopback-only production-config frontend in a separate terminal:

```powershell
Set-Location 'C:\Users\ykpra\HOTEL MANGEMENT'
npm.cmd run dev:production
```

Open `http://localhost:5175/staff.html`. This uses the Firebase project configuration in the ignored `.env` and `.env.local` files, plus the production RTDB endpoint in ignored `.env.production`; it does not use the Auth Emulator. In Firebase Console, verify **Authentication → Sign-in method → Google** is enabled and **Authentication → Settings → Authorized domains** includes `localhost`. Allow popup windows for the site. Sign in with the Google account whose verified email is configured as Admin or has an active supervisor grant.

This mode connects to the configured Firebase project, including its RTDB and deployed Functions, not just Authentication. Do not place test orders or use staff management controls against live data. The local frontend does not deploy Functions. If the staff backend is not already deployed, supervisor role checks will fail until the trusted Functions are deployed with owner approval; deployment requires Blaze billing. The emulator instructions below remain the safe option for test data and backend tests.

Open two PowerShell terminals in the project folder.

Terminal 1 (Auth, RTDB, and Functions emulators):

```powershell
Set-Location 'C:\Users\ykpra\HOTEL MANGEMENT'
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
java -version
npm.cmd run backend:lan
```

Wait for “All emulators ready.” The project ID shown must start with `demo-`.

Terminal 2 (website in emulator mode):

```powershell
Set-Location 'C:\Users\ykpra\HOTEL MANGEMENT'
npm.cmd run dev:lan
```

Open `http://localhost:5174/` on the PC. For real phone QR scans on the same Wi-Fi, open the staff portal using the PC's current Wi-Fi IP (the Vite terminal prints it), then generate/print QR codes. Each QR opens the normal menu entry `/?table=N`; it does not submit an order. The customer flow and trusted backend accept tables 1–11.

To load sample menu and 11 tables into **only the running demo RTDB emulator**, use a third PowerShell terminal:

```powershell
Set-Location 'C:\Users\ykpra\HOTEL MANGEMENT'
$env:GCLOUD_PROJECT = 'demo-hotel-mangment-system-b4aa8'
$env:FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000'
npm.cmd --prefix functions run seed:emulator
```

The seed script requires the demo project and local emulator host together and refuses to seed production if an emulator host is set. No Application Default Credentials are needed for emulator-only database writes. Emulator data is separate from production data.

Run authorized/unauthorized staff backend checks against only these emulators:

```powershell
Set-Location 'C:\Users\ykpra\HOTEL MANGEMENT'
$env:GCLOUD_PROJECT = 'demo-hotel-mangment-system-b4aa8'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
$env:FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000'
npm.cmd --prefix functions run test:staff-emulator
```

The test creates temporary emulator-only accounts and access data, asserts that an active supervisor is allowed and an ungranted account is denied, then removes its test records. It never uses production credentials.

## Hosting and database rules deployment

Build and deploy only Realtime Database rules and Hosting:

```powershell
npm.cmd run build
npx firebase deploy --only database,hosting --project hotel-mangment-system-b4aa8
```

Do not deploy Firestore rules. `firestore.rules` and its rollback file are legacy local files and are not referenced from `firebase.json`.

## Same-Wi-Fi emulator testing

The local emulator mode runs the trusted Functions code with Auth and RTDB in the demo emulators only. It is not a public production backend. Never expose emulator ports to the public internet. If Windows Firewall prompts, allow Node.js only on a trusted private network; keep the emulator terminals running during tests.

Customers do not make payments in this app. They select menu items and submit the order; authorized staff accept it, prepare it, and mark it delivered. RTDB rules continue denying direct customer writes to `/orders`; all order creation and status changes go through trusted Functions code.

### Optional cloud deployment

To make ordering work when the PC is off or customers are outside the local network, link billing/upgrade the project to Blaze and deploy all trusted Functions:

```powershell
npm.cmd run deploy:trusted-backend
```

For a production build, use production Firebase config in `.env`, build without the emulator mode, and deploy only after owner review. Cloud Functions deployment requires Firebase Blaze and may incur charges; do not change billing without owner approval.

Existing Firestore orders will not appear in RTDB dashboards unless explicitly migrated through a controlled process.

## Safety

- Root `.env` and `.env.local` are ignored. `VITE_*` values are public browser configuration, never private keys.
- Never put Firebase Admin credentials in frontend code or environment variables beginning with `VITE_`.
- Revoke the Firebase service-account private key previously exposed in chat.
- Do not open RTDB write permissions to `auth != null` or `true` to make ordering appear to work.
