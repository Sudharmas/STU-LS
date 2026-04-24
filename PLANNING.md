# STU-LS Brief Planning (Desktop First)

## 1. Product Goal
Build a secure, high-performance, installable desktop application (Windows/macOS/Linux) for centralized student attendance, marks, course lifecycle, and semester progression tracking.

Mobile app support will be added later by reusing the same backend/API and data contracts.

## 2. Scope Summary
### In Scope (Phase 1: Desktop)
- Multi-role system:
  - Platform Admin (company level)
  - Super Admin (institution head)
  - Department Admin (HOD)
  - Lecturer
  - Student (view-only for most data)
- Auth + role-based access control.
- Offline-first local data storage with automatic sync to online database when network is available.
- Course creation, enrollment (invite/request), attendance, internal marks, progress tracking.
- Course ending flow with student-side grace period view and auto-removal after 15 days.
- Semester progression workflow with lecturer-controlled pass/fail override.
- Bulk user creation, manual creation, and Excel-based student import with duplicate prevention.
- Export (CSV/Excel) for lecturer/admin filtered data.
- Installable desktop packages.
- API documentation + deployment documentation.

### Out of Scope (Phase 1)
- Mobile app UI implementation (planned for Phase 2).

## 3. Core Functional Requirements
1. User Lifecycle & Hierarchy
- Platform Admin creates institutions and Super Admin credentials.
- Super Admin creates Department Admins.
- Department Admin creates Lecturers first, then Students.
- Duplicate user prevention across all creation paths.

2. Authentication & Security
- Credentials created by admins (default password = username initially, must be changeable).
- Secure local credential storage for offline login.
- Role-based authorization for every feature.

3. Course & Enrollment
- Lecturer creates/ends courses.
- Student can request to join courses.
- Lecturer can accept/reject join requests.
- Ended course appears as ending state to student, then removable by student or auto-remove after 15 days.

4. Attendance & Marks
- Lecturer marks attendance per course and student (P/A).
- Internal marks updated by lecturer.
- Student uploads external marks.
- Semester move decision based on rules, but lecturer has final pass/fail control including re-exam bypass.

5. Student Dashboard
- Attendance % by subject.
- Enrolled/current/completed courses.
- Semester status and internal marks visibility.
- Course progress visibility.

6. Data Export
- Lecturer/Admin filter by department, course, semester.
- Export filtered records to CSV and Excel.

## 4. Technical Approach (Recommended)
1. Desktop App Framework
- Use Tauri (Rust backend + web UI shell) for lightweight, secure, cross-platform desktop builds.

2. Local Database
- SQLite (optionally encrypted with SQLCipher).
- Strict relational schema with foreign keys, constraints, and soft-delete where required.

3. Sync Model (Offline First)
- Every local write creates a sync event in an outbox table.
- Record metadata per row: `version`, `updated_at`, `sync_state` (`local_new`, `local_updated`, `synced`, `server_new`).
- Sync engine:
  - Push unsynced local changes first.
  - Pull remote changes after successful push.
  - Conflict handling with deterministic rules + audit logging.

4. API & Backend
- Backend service with institution-aware multi-tenant model.
- REST API (or REST + WebSocket for notifications).
- Shared DTO contracts for future mobile app reuse.

5. Security
- Password hashing (Argon2/bcrypt), secure token/session strategy.
- Encrypted local secrets.
- Full audit logs for critical operations (user creation, marks change, course end, semester promotion).

## 5. High-Level Data Modules
- Identity & Roles
- Institution/Department
- Users (Lecturer/Student/Admin hierarchy)
- Courses & Enrollment Requests
- Attendance Records
- Marks (Internal/External/Final Decision)
- Semester Progression Rules + Overrides
- Sync Queue + Change Log
- Notifications

## 6. Development Plan (Step-by-Step)
1. Discovery & Final Spec Freeze
- Convert requirements into formal user stories and acceptance criteria.
- Lock ID-generation rules and edge cases.

2. System Design
- ERD/database schema design.
- API contract definitions.
- Role-permission matrix.

3. Foundation Setup
- Monorepo/project setup.
- Local DB layer + migrations.
- Authentication + RBAC.

4. Admin Features
- Institution/Super Admin/Department Admin creation.
- Lecturer and student creation (manual, bulk, Excel upload).

5. Lecturer Features
- Course lifecycle, enrollment approvals.
- Attendance marking.
- Internal marks and course progress updates.
- CSV/Excel exports.

6. Student Features
- Dashboard read models.
- External marks submission.
- Ending-course interactions.

7. Sync Engine
- Outbox/inbox implementation.
- Offline/online transition handling.
- Conflict resolution and retry policies.

8. Semester Logic
- Pass/fail workflow and lecturer override implementation.
- Auto progression/reset behavior.

9. Testing & Hardening
- Unit, integration, sync, and role-security tests.
- Performance testing with large datasets.

10. Packaging & Docs
- Desktop installers (Windows/MSI, macOS/DMG, Linux/AppImage or deb/rpm).
- API docs for mobile reuse.
- Deployment and operations guide.

## 7. Required Documentation Deliverables
- Planning document (this file + detailed technical plan next).
- API documentation (endpoints, auth, payloads, errors, examples).
- Deployment documentation (build, signing, installer generation, release process).
- Admin/User operation manuals.

## 8. Immediate Next Actions
1. Create detailed SRS + acceptance criteria per module.
2. Finalize tech stack decision (Tauri vs Electron vs Flutter Desktop).
3. Design database schema and sync metadata model.
4. Draft API v1 spec for identity, users, courses, attendance, marks, semester progression.

## 9. Implementation Status (April 18, 2026)
Completed in current workspace:
- Desktop scaffold implemented with Tauri + React + TypeScript.
- Local SQLite schema and migrations implemented for users, courses, enrollment, attendance, marks, sync, audit, semester, and progress.
- Local command API implemented for:
  - auth and user hierarchy management
  - bulk lecturer and student creation
  - course creation/listing/end lifecycle
  - enrollment request/approval
  - attendance and marks updates
  - student dashboard read model
  - semester promote/reset logic with force override
  - CSV/Excel export and sync queue stats
- Role-based desktop UI implemented for admin, lecturer, and student operations.
- Online sync service contract and local outbox processor command implemented.
- Reference sync server implemented in-workspace with /sync/push and pull-queue simulation endpoints.
- In-app Excel/CSV parsing workflow implemented for student bulk account creation.
- Automated test suite added for parsing and input processing helpers.
- Rust integration-style tests added for sync processor internals (runnable once Cargo is installed).
- Release packaging scripts added for Windows/macOS/Linux targets.
- Planning, SRS, API, architecture, deployment, and stepwise development documents added.

Pending for production-complete system:
- Remote online backend service and two-way sync transport.
- Excel file upload pipeline for student generation from workbook.
- Full automated tests and installer signing/notarization.
