# STU-LS

Desktop-first, offline-capable student lifecycle system for attendance, marks, and course tracking.

## Databases
- Local desktop database: SQLite.
- Online sync database: Supabase Postgres (used by root `backend-server`).

## Current Foundation
- Monorepo scaffold for desktop app and shared contracts.
- Tauri desktop app shell with React + TypeScript frontend.
- Local SQLite migration for core identity and academic entities.
- End-to-end core desktop flows:
   - user hierarchy + manual and bulk creation
   - Excel/CSV upload parsing for student account creation
   - course lifecycle + enrollment requests
   - attendance, internal/external marks, lecturer decision
   - semester promotion/reset and ended-course 15-day cleanup
   - CSV/Excel export for academic data
   - online sync contract + local outbox processor (dry-run and live modes)

## Workspace Layout
- `apps/desktop`: Installable cross-platform desktop app (Tauri + React).
- `packages/contracts`: Shared TypeScript types for future mobile and server reuse.
- `docs`: Architecture, API, and deployment documentation.

## Quick Start
1. Install prerequisites:
   - Node.js 20+
   - Rust stable toolchain
   - Tauri prerequisites for your OS
2. Install dependencies:
   - `npm install`
3. Run desktop app in dev mode:
   - `npm run dev:desktop`

## Test
- `npm run test:desktop`
- `npm run test:sync-server`

Rust sync integration tests (after Rust/Cargo install):
- `npm run test:rust-sync`

## Backend Server (Online)
- Start server: `npm run dev:backend-server`
- Server URL: `http://localhost:8090`
- Unified desktop-server sync route: `POST /sync/bridge`
- Desktop sync UI should use this URL with Dry run unchecked for live sync.

## Credentials Configuration
1. Backend server:
- Copy `backend-server/.env.example` to `backend-server/.env`
- Set `SUPABASE_DB_URL` and optional `BACKEND_SERVER_BEARER_TOKEN`

2. Desktop defaults (optional):
- Copy `apps/desktop/.env.example` to `apps/desktop/.env`
- Set `VITE_SYNC_SERVER_URL` and optional `VITE_SYNC_BEARER_TOKEN`

3. Supabase schema:
- Apply migrations command: `npm run db:migrate:backend`
- Alternative manual method: run SQL from `supabase/schema.sql` in Supabase SQL Editor

Important: schema creation is not automatic on app start. It is executed once by you.

## One Command Run
- `npm run run:app`

## Release Build
- Windows: `npm run release:windows`
- macOS: `npm run release:mac`
- Linux: `npm run release:linux`

## Notes
- Rust toolchain must be installed to run Tauri backend locally.
- Current implementation is desktop-first. Mobile client can reuse documented API contracts and data models in next phase.
