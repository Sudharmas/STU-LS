# STU-LS System Architecture

## 1. Runtime Architecture
1. Desktop client:
- Tauri application (`Rust commands + React UI`).
- Primary working database is local SQLite (offline-first).

2. Online sync bridge:
- Node/Express `backend-server`.
- Single sync endpoint: `POST /sync/bridge`.

3. Online storage:
- Supabase Postgres.
- Holds synced domain data and student update tracking state.

## 2. Layered Design
1. UI layer (`apps/desktop/src/main.tsx`):
- Role-based panels and workflows.
- Handles login, refresh, background sync triggers, and status rendering.

2. Command layer (`apps/desktop/src-tauri/src/main.rs`):
- Implements auth checks, role access control, validation, and transactional writes.
- Exposes Tauri commands used by UI.

3. Local data layer (SQLite):
- Users, students, courses, enrollment, attendance, marks, semester records.
- Sync outbox and metadata for eventual consistency.

4. Online bridge layer (`backend-server/src/server.js`, `backend-server/src/store.js`):
- Validates payloads.
- Applies accepted outbox operations to Supabase.
- Computes pull payload for clients (especially student updates).

## 3. Sync Model (Current)
1. Write path:
- UI action -> Tauri command -> local SQLite write -> outbox record.

2. Push/pull path:
- Desktop calls `process_outbox_and_sync`.
- Tauri posts outbox batch to `/sync/bridge`.
- Server returns:
	- `accepted_outbox_ids`
	- `rejected`
	- `pull_changes`
	- `update_available`
	- `notifications`

3. Reconciliation path:
- Local outbox statuses are updated.
- `pull_changes` are applied into local SQLite.

## 4. Student Update Propagation
1. Lecturer/admin updates student-linked records (marks, enrollment, attendance, semester, etc.).
2. Server marks impacted students as `update_available = true`.
3. When student sync runs:
- If update is available, server returns student-specific `pull_changes` and notifications.
- If no update is available, client continues using local SQLite state.

This behavior keeps the app offline-capable while still surfacing central updates quickly when online.

## 5. Data Domains
1. Identity and hierarchy:
- `platform_admin -> super_admin -> department_admin -> lecturer/student`.

2. Student model:
- Dedicated `students` table plus relationship tables (`student_lecturer_relationships`, `student_admin_relationships`).
- Bulk creation pipelines create user + student records with relationship links.

3. Academic lifecycle:
- Course creation/catalog/enrollment.
- Attendance and marks.
- Lecturer final decision and semester promotion/reset flows.

## 6. Security Model
1. Local auth:
- Password hashes with Argon2.
- Role checks at command boundary.

2. Server auth:
- Optional Bearer token (`BACKEND_SERVER_BEARER_TOKEN`) for `/sync/bridge`.

3. Session behavior:
- Desktop keeps in-app session across refresh using session storage token.
- Session ends on explicit logout or app close.

## 7. Availability Strategy
1. Desktop always runs with local SQLite, even when offline.
2. Sync endpoint resolution order:
- Primary hosted URL (`VITE_SYNC_SERVER_URL`).
- Fallback URLs (`VITE_SYNC_FALLBACK_URLS`).
3. If all sync endpoints are unavailable:
- App remains functional in local mode.
- Pending outbox records sync once connectivity returns.
