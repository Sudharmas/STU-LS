import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";

const DATA_DIR = path.resolve(process.cwd(), "apps/sync-server/data");
const DATA_FILE = path.join(DATA_DIR, "sync-store.json");

const DEFAULT_STATE = {
  clients: {},
  pullQueue: []
};

const useSupabase =
  process.env.NODE_ENV !== "test" &&
  process.env.USE_SUPABASE === "true" &&
  Boolean(process.env.SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabase = useSupabase
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

async function runPg(sql, params = []) {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error("SUPABASE_DB_URL is required for direct SQL user persistence");
  }

  const client = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // eslint-disable-next-line no-console
    console.log(`[sync-store] runPg query executing with ${params.length} params`);
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function upsertUserDirect(normalized) {
  const sqlWithInternalSecurity = `
    INSERT INTO public.users (id, username, password_hash, role, department, college_uid, college_name, college_identification_number, full_name, internal_password_hash, internal_password_required, is_active, created_at, updated_at, version, sync_state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::timestamptz, $15, $16)
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      password_hash = EXCLUDED.password_hash,
      role = EXCLUDED.role,
      department = EXCLUDED.department,
      college_uid = EXCLUDED.college_uid,
      college_name = EXCLUDED.college_name,
      college_identification_number = EXCLUDED.college_identification_number,
      full_name = EXCLUDED.full_name,
      internal_password_hash = EXCLUDED.internal_password_hash,
      internal_password_required = EXCLUDED.internal_password_required,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at,
      version = EXCLUDED.version,
      sync_state = EXCLUDED.sync_state
  `;

  const paramsWithInternalSecurity = [
    normalized.id,
    normalized.username,
    normalized.password_hash,
    normalized.role,
    normalized.department,
    normalized.college_uid,
    normalized.college_name,
    normalized.college_identification_number,
    normalized.full_name,
    normalized.internal_password_hash,
    normalized.internal_password_required,
    normalized.is_active,
    normalized.created_at,
    normalized.updated_at,
    normalized.version,
    normalized.sync_state
  ];

  try {
    await runPg(sqlWithInternalSecurity, paramsWithInternalSecurity);
  } catch (error) {
    const message = String(error?.message ?? error ?? "").toLowerCase();
    const missingInternalSecurityColumns =
      message.includes("internal_password_hash") || message.includes("internal_password_required");
    const missingFullNameColumn = message.includes("full_name");

    if (!missingInternalSecurityColumns && !missingFullNameColumn) {
      throw error;
    }

    // Backward-compatible fallback for deployments where new users columns are not migrated yet.
    const legacySql = `
      INSERT INTO public.users (id, username, password_hash, role, department, college_uid, college_name, college_identification_number, is_active, created_at, updated_at, version, sync_state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12, $13)
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        department = EXCLUDED.department,
        college_uid = EXCLUDED.college_uid,
        college_name = EXCLUDED.college_name,
        college_identification_number = EXCLUDED.college_identification_number,
        is_active = EXCLUDED.is_active,
        updated_at = EXCLUDED.updated_at,
        version = EXCLUDED.version,
        sync_state = EXCLUDED.sync_state
    `;

    await runPg(legacySql, [
      normalized.id,
      normalized.username,
      normalized.password_hash,
      normalized.role,
      normalized.department,
      normalized.college_uid,
      normalized.college_name,
      normalized.college_identification_number,
      normalized.is_active,
      normalized.created_at,
      normalized.updated_at,
      normalized.version,
      normalized.sync_state
    ]);
  }
  // eslint-disable-next-line no-console
  console.log(`[sync-store] upsertUserDirect success id=${normalized.id} username=${normalized.username}`);
}

async function softDeleteUserDirect(recordId) {
  const sql = `
    UPDATE public.users
    SET is_active = false, sync_state = 'deleted', updated_at = now()
    WHERE id = $1
  `;
  await runPg(sql, [recordId]);
  // eslint-disable-next-line no-console
  console.log(`[sync-store] softDeleteUserDirect success id=${recordId}`);
}

function assertSupabase() {
  if (!supabase) {
    throw new Error("Supabase is not configured. Set USE_SUPABASE=true and required credentials.");
  }
  return supabase;
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2), "utf-8");
  }
}

function readState() {
  ensureStore();
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function writeState(state) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function processPushPayload(payload) {
  if (useSupabase) {
    return processPushPayloadSupabase(payload);
  }

  const state = readState();
  const accepted = [];
  const rejected = [];

  if (!state.clients[payload.client_id]) {
    state.clients[payload.client_id] = {
      lastSeenAt: null,
      records: []
    };
  }

  for (const item of payload.records ?? []) {
    if (!item || typeof item !== "object") {
      rejected.push({ outbox_id: -1, reason: "invalid record payload" });
      continue;
    }

    if (typeof item.outbox_id !== "number" || item.outbox_id <= 0) {
      rejected.push({ outbox_id: item.outbox_id ?? -1, reason: "invalid outbox_id" });
      continue;
    }

    const supportedTables = new Set(["users", "courses", "course_members", "marks", "enrollment_requests"]);
    if (!supportedTables.has(item.table_name)) {
      rejected.push({ outbox_id: item.outbox_id, reason: "unsupported table_name" });
      continue;
    }

    accepted.push(item.outbox_id);

    // Keep a basic event log per client for debugging and replay simulation.
    state.clients[payload.client_id].records.push({
      ...item,
      received_at: new Date().toISOString()
    });
  }

  state.clients[payload.client_id].lastSeenAt = new Date().toISOString();

  const pullChanges = state.pullQueue.splice(0, 100);
  writeState(state);

  return {
    accepted_outbox_ids: accepted,
    rejected,
    pull_changes: pullChanges
  };
}

export function enqueuePullChange(change) {
  if (useSupabase) {
    return enqueuePullChangeSupabase(change);
  }

  const state = readState();
  state.pullQueue.push(change);
  writeState(state);
  return { queued: state.pullQueue.length };
}

export function getStateSnapshot() {
  if (useSupabase) {
    return getStateSnapshotSupabase();
  }

  return readState();
}

export async function getStorageHealth() {
  if (!useSupabase) {
    return {
      ok: true,
      mode: "local_file"
    };
  }

  const sb = assertSupabase();
  const { error } = await sb.from("sync_clients").select("client_id", { head: true, count: "exact" });
  if (error) {
    return {
      ok: false,
      mode: "supabase",
      error: error.message
    };
  }

  return {
    ok: true,
    mode: "supabase"
  };
}

async function processPushPayloadSupabase(payload) {
  const sb = assertSupabase();
  const accepted = [];
  const rejected = [];

  const { error: clientUpsertError } = await sb.from("sync_clients").upsert(
    {
      client_id: payload.client_id,
      last_seen_at: new Date().toISOString()
    },
    { onConflict: "client_id" }
  );
  if (clientUpsertError) {
    throw clientUpsertError;
  }

  const supportedTables = new Set([
    "users",
    "courses",
    "course_members",
    "marks",
    "enrollment_requests",
    "attendance_records",
    "student_semesters",
    "course_progress_log"
  ]);
  for (const item of payload.records ?? []) {
    if (!item || typeof item !== "object") {
      rejected.push({ outbox_id: -1, reason: "invalid record payload" });
      continue;
    }

    if (typeof item.outbox_id !== "number" || item.outbox_id <= 0) {
      rejected.push({ outbox_id: item.outbox_id ?? -1, reason: "invalid outbox_id" });
      continue;
    }

    if (!supportedTables.has(item.table_name)) {
      rejected.push({ outbox_id: item.outbox_id, reason: "unsupported table_name" });
      continue;
    }

    let payloadObj = {};
    try {
      payloadObj = typeof item.payload === "string" ? JSON.parse(item.payload) : item.payload;
    } catch {
      rejected.push({ outbox_id: item.outbox_id, reason: "invalid payload json" });
      continue;
    }

    const { error: eventInsertError } = await sb.from("sync_events").upsert(
      {
        client_id: payload.client_id,
        outbox_id: item.outbox_id,
        table_name: item.table_name,
        record_id: item.record_id,
        operation: item.operation,
        payload: payloadObj,
        retries: item.retries ?? 0,
        received_at: new Date().toISOString()
      },
      { onConflict: "client_id,outbox_id", ignoreDuplicates: true }
    );

    if (eventInsertError) {
      rejected.push({ outbox_id: item.outbox_id, reason: eventInsertError.message });
      continue;
    }

    try {
      await applyDomainChangeSupabase(sb, item.table_name, item.operation, payloadObj);
      // eslint-disable-next-line no-console
      console.log(`[sync-store] domain apply ok table=${item.table_name} op=${item.operation} record=${item.record_id}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[sync-store] domain apply failed table=${item.table_name} op=${item.operation} record=${item.record_id}: ${error.message ?? error}`
      );
      rejected.push({ outbox_id: item.outbox_id, reason: error.message ?? "domain upsert failed" });
      continue;
    }

    accepted.push(item.outbox_id);
  }

  const { data: pullRows, error: pullFetchError } = await sb
    .from("sync_pull_queue")
    .select("id, table_name, operation, record")
    .eq("status", "queued")
    .order("id", { ascending: true })
    .limit(100);

  if (pullFetchError) {
    throw pullFetchError;
  }

  const pullChanges = (pullRows ?? []).map((row) => ({
    table_name: row.table_name,
    operation: row.operation,
    record: row.record
  }));

  const pullIds = (pullRows ?? []).map((row) => row.id);
  if (pullIds.length > 0) {
    const { error: markPulledError } = await sb
      .from("sync_pull_queue")
      .update({ status: "pulled" })
      .in("id", pullIds);
    if (markPulledError) {
      throw markPulledError;
    }
  }

  return {
    accepted_outbox_ids: accepted,
    rejected,
    pull_changes: pullChanges
  };
}

function normalizeRecordForTable(tableName, record) {
  const source = record ?? {};
  if (tableName === "users") {
    return {
      id: source.id,
      username: source.username,
      password_hash: source.password_hash,
      role: source.role,
      department: source.department ?? null,
      college_uid: source.college_uid ?? null,
      college_name: source.college_name ?? null,
      college_identification_number: source.college_identification_number ?? null,
      full_name: source.full_name ?? null,
      internal_password_hash: source.internal_password_hash ?? null,
      internal_password_required: source.internal_password_required ?? true,
      is_active: source.is_active ?? true,
      created_at: source.created_at ?? new Date().toISOString(),
      updated_at: source.updated_at ?? new Date().toISOString(),
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  if (tableName === "courses") {
    return {
      id: source.id,
      code: source.code,
      title: source.title,
      lecturer_user_id: source.lecturer_user_id,
      department: source.department ?? null,
      semester: source.semester,
      status: source.status ?? "active",
      end_announced_at: source.end_announced_at ?? null,
      created_at: source.created_at ?? new Date().toISOString(),
      updated_at: source.updated_at ?? new Date().toISOString(),
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  if (tableName === "enrollment_requests") {
    return {
      id: source.id,
      course_id: source.course_id,
      student_user_id: source.student_user_id,
      status: source.status ?? "pending",
      created_at: source.created_at ?? new Date().toISOString(),
      updated_at: source.updated_at ?? new Date().toISOString(),
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  if (tableName === "course_members") {
    return {
      id: source.id,
      course_id: source.course_id,
      student_user_id: source.student_user_id,
      joined_at: source.joined_at ?? new Date().toISOString(),
      removed_at: source.removed_at ?? null,
      removal_deadline_at: source.removal_deadline_at ?? null,
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  if (tableName === "attendance_records") {
    return {
      id: source.id,
      course_id: source.course_id,
      student_user_id: source.student_user_id,
      attendance_date: source.attendance_date,
      status: source.status,
      marked_by: source.marked_by,
      created_at: source.created_at ?? new Date().toISOString(),
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  if (tableName === "marks") {
    return {
      id: source.id,
      course_id: source.course_id,
      student_user_id: source.student_user_id,
      internal_marks: source.internal_marks ?? null,
      external_marks: source.external_marks ?? null,
      lecturer_decision: source.lecturer_decision ?? null,
      updated_by: source.updated_by,
      updated_at: source.updated_at ?? new Date().toISOString(),
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  if (tableName === "student_semesters") {
    return {
      student_user_id: source.student_user_id,
      current_semester: source.current_semester ?? 1,
      updated_at: source.updated_at ?? new Date().toISOString(),
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  if (tableName === "course_progress_log") {
    return {
      id: source.id,
      course_id: source.course_id,
      lecturer_user_id: source.lecturer_user_id,
      progress_text: source.progress_text,
      progress_date: source.progress_date,
      created_at: source.created_at ?? new Date().toISOString(),
      version: source.version ?? 1,
      sync_state: source.sync_state ?? "server_new"
    };
  }

  return source;
}

async function applyDomainChangeSupabase(sb, tableName, operation, record) {
  if (!record || typeof record !== "object") {
    throw new Error("payload record missing");
  }

  const normalized = normalizeRecordForTable(tableName, record);
  const recordId = normalized.id ?? normalized.student_user_id;
  if (!recordId) {
    throw new Error("record id missing");
  }

  if (operation === "delete") {
    if (tableName === "users") {
      await softDeleteUserDirect(recordId);
      return;
    }

    if (tableName === "courses") {
      const { error } = await sb.from("courses").update({ status: "ended", sync_state: "deleted" }).eq("id", recordId);
      if (error) throw error;
      return;
    }

    if (tableName === "course_members") {
      const { error } = await sb.from("course_members").update({ removed_at: new Date().toISOString(), sync_state: "deleted" }).eq("id", recordId);
      if (error) throw error;
      return;
    }

    if (tableName === "student_semesters") {
      const { error } = await sb.from("student_semesters").delete().eq("student_user_id", normalized.student_user_id);
      if (error) throw error;
      return;
    }

    const { error } = await sb.from(tableName).delete().eq("id", recordId);
    if (error) throw error;
    return;
  }

  const conflictTarget = tableName === "student_semesters" ? "student_user_id" : "id";

  if (tableName === "users") {
    await upsertUserDirect(normalized);
    return;
  }

  const { error } = await sb.from(tableName).upsert(normalized, { onConflict: conflictTarget });
  if (error) throw error;
}

async function enqueuePullChangeSupabase(change) {
  const sb = assertSupabase();
  const { data, error } = await sb
    .from("sync_pull_queue")
    .insert({
      table_name: change.table_name,
      operation: change.operation,
      record: change.record,
      status: "queued"
    })
    .select("id");

  if (error) {
    throw error;
  }

  return { queued: data?.length ?? 0 };
}

async function getStateSnapshotSupabase() {
  const sb = assertSupabase();

  const [{ count: clientsCount, error: clientsErr }, { count: eventsCount, error: eventsErr }, { count: pullQueuedCount, error: pullErr }] =
    await Promise.all([
      sb.from("sync_clients").select("*", { count: "exact", head: true }),
      sb.from("sync_events").select("*", { count: "exact", head: true }),
      sb.from("sync_pull_queue").select("*", { count: "exact", head: true }).eq("status", "queued")
    ]);

  if (clientsErr || eventsErr || pullErr) {
    throw clientsErr || eventsErr || pullErr;
  }

  return {
    mode: "supabase",
    clients_count: clientsCount ?? 0,
    events_count: eventsCount ?? 0,
    pull_queue_count: pullQueuedCount ?? 0
  };
}
