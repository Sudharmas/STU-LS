#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod user_repository;
mod student_repository;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{Duration, Utc};
use rand::Rng;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use rust_xlsxwriter::Workbook;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::Manager;
use thiserror::Error;

#[derive(Debug, Error)]
enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("path resolution failed")]
    PathResolution,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("access denied")]
    AccessDenied,
    #[error("invalid role transition")]
    InvalidRoleTransition,
    #[error("user already exists")]
    UserAlreadyExists,
    #[error("password hash error")]
    PasswordHash,
    #[error("actor not found")]
    ActorNotFound,
    #[error("target not found")]
    TargetNotFound,
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("export failed: {0}")]
    Export(String),
    #[error("http error: {0}")]
    Http(String),
    #[error("json error: {0}")]
    Json(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[derive(Debug, Clone, Serialize)]
struct UserSummary {
    id: i64,
    username: String,
    full_name: Option<String>,
    role: String,
    department: Option<String>,
    is_active: bool,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct CourseSummary {
    id: i64,
    code: String,
    title: String,
    department: Option<String>,
    semester: i64,
    status: String,
    lecturer_username: String,
}

#[derive(Debug, Clone, Serialize)]
struct EnrollmentRequestSummary {
    id: i64,
    course_id: i64,
    course_code: String,
    student_username: String,
    status: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct StudentDashboardCourse {
    course_id: i64,
    course_code: String,
    course_title: String,
    semester: i64,
    status: String,
    attendance_percent: f64,
    internal_marks: Option<i64>,
    external_marks: Option<i64>,
    lecturer_decision: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct StudentDashboard {
    username: String,
    current_semester: i64,
    courses: Vec<StudentDashboardCourse>,
}

#[derive(Debug, Clone, Serialize)]
struct CredentialRow {
    username: String,
    password: String,
    full_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DepartmentAdminBulkDefaults {
    college_code: String,
    department_code: String,
    lecturer_prefix: String,
    student_prefix: String,
}

#[derive(Debug, Clone, Serialize)]
struct BulkJobStatusPayload {
    status: String,
    created: Vec<CredentialRow>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct BulkJobState {
    status: String,
    created: Vec<CredentialRow>,
    error: Option<String>,
}

impl BulkJobState {
    fn queued() -> Self {
        Self {
            status: "queued".to_string(),
            created: Vec::new(),
            error: None,
        }
    }

    fn running() -> Self {
        Self {
            status: "running".to_string(),
            created: Vec::new(),
            error: None,
        }
    }

    fn completed(created: Vec<CredentialRow>) -> Self {
        Self {
            status: "completed".to_string(),
            created,
            error: None,
        }
    }

    fn failed(error: String) -> Self {
        Self {
            status: "failed".to_string(),
            created: Vec::new(),
            error: Some(error),
        }
    }

    fn as_payload(&self) -> BulkJobStatusPayload {
        BulkJobStatusPayload {
            status: self.status.clone(),
            created: self.created.clone(),
            error: self.error.clone(),
        }
    }
}

static BULK_JOBS: OnceLock<Mutex<HashMap<String, BulkJobState>>> = OnceLock::new();

fn bulk_jobs_store() -> &'static Mutex<HashMap<String, BulkJobState>> {
    BULK_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Deserialize)]
struct AttendanceEntryInput {
    student_username: String,
    attendance_date: String,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
struct OutboxRecord {
    outbox_id: i64,
    table_name: String,
    record_id: i64,
    operation: String,
    payload: String,
    created_at: String,
    retries: i64,
}

#[derive(Debug, Clone, Serialize)]
struct SyncPushRequest {
    client_id: String,
    sent_at: String,
    actor_username: Option<String>,
    actor_role: Option<String>,
    records: Vec<OutboxRecord>,
}

#[derive(Debug, Clone, Deserialize)]
struct SyncRejectedItem {
    outbox_id: i64,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncPullChange {
    table_name: String,
    operation: String,
    record: Value,
}

#[derive(Debug, Clone, Deserialize)]
struct SyncServerResponse {
    accepted_outbox_ids: Vec<i64>,
    rejected: Vec<SyncRejectedItem>,
    pull_changes: Vec<SyncPullChange>,
    #[serde(default)]
    update_available: bool,
    #[serde(default)]
    notifications: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
struct SyncProcessResult {
    mode: String,
    queued: i64,
    pushed: i64,
    failed: i64,
    pulled: i64,
    update_available: bool,
    notifications_count: i64,
    payload_preview: String,
}

fn app_db_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let app_data_dir = app.path().app_data_dir().map_err(|_| AppError::PathResolution)?;
    fs::create_dir_all(&app_data_dir)?;
    Ok(app_data_dir.join("stuls.sqlite"))
}

fn open_connection(app: &tauri::AppHandle) -> Result<Connection, AppError> {
    let db_path = app_db_path(app)?;
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

fn apply_migration(conn: &Connection) -> Result<(), AppError> {
    let sql_1 = include_str!("../migrations/0001_init.sql");
    let sql_2 = include_str!("../migrations/0002_academic_extensions.sql");
    let sql_3 = include_str!("../migrations/0003_sync_contract.sql");
    let sql_4 = include_str!("../migrations/0004_students_table.sql");
    conn.execute_batch(sql_1)?;
    conn.execute_batch(sql_2)?;
    conn.execute_batch(sql_3)?;
    conn.execute_batch(sql_4)?;
    ensure_users_college_columns(conn)?;
    ensure_users_internal_security_columns(conn)?;
    ensure_users_profile_columns(conn)?;
    Ok(())
}

fn ensure_users_college_columns(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(users)")?;
    let columns = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;

    let has_college_uid = columns.iter().any(|c| c == "college_uid");
    let has_college_name = columns.iter().any(|c| c == "college_name");
    let has_college_identification_number = columns
        .iter()
        .any(|c| c == "college_identification_number");

    if !has_college_uid {
        conn.execute("ALTER TABLE users ADD COLUMN college_uid TEXT", [])?;
    }
    if !has_college_name {
        conn.execute("ALTER TABLE users ADD COLUMN college_name TEXT", [])?;
    }
    if !has_college_identification_number {
        conn.execute(
            "ALTER TABLE users ADD COLUMN college_identification_number TEXT",
            [],
        )?;
    }

    Ok(())
}

fn ensure_users_internal_security_columns(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(users)")?;
    let columns = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;

    let has_internal_password_hash = columns.iter().any(|c| c == "internal_password_hash");
    let has_internal_password_required = columns.iter().any(|c| c == "internal_password_required");

    if !has_internal_password_hash {
        conn.execute("ALTER TABLE users ADD COLUMN internal_password_hash TEXT", [])?;
    }
    if !has_internal_password_required {
        conn.execute(
            "ALTER TABLE users ADD COLUMN internal_password_required INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }

    Ok(())
}

fn ensure_users_profile_columns(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(users)")?;
    let columns = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;

    let has_full_name = columns.iter().any(|c| c == "full_name");
    if !has_full_name {
        conn.execute("ALTER TABLE users ADD COLUMN full_name TEXT", [])?;
    }

    Ok(())
}

fn generate_college_uid() -> String {
    let mut rng = rand::thread_rng();
    format!("CLG-{}-{:04}", Utc::now().timestamp_millis(), rng.gen_range(1000..9999))
}

fn create_bulk_job_id(prefix: &str) -> String {
    let mut rng = rand::thread_rng();
    format!(
        "{}-{}-{:06}",
        prefix,
        Utc::now().timestamp_millis(),
        rng.gen_range(0..1_000_000)
    )
}

fn set_bulk_job_state(job_id: &str, state: BulkJobState) {
    if let Ok(mut jobs) = bulk_jobs_store().lock() {
        jobs.insert(job_id.to_string(), state);
    }
}

fn get_bulk_job_state(job_id: &str) -> BulkJobStatusPayload {
    if let Ok(jobs) = bulk_jobs_store().lock() {
        if let Some(state) = jobs.get(job_id) {
            return state.as_payload();
        }
    }

    BulkJobStatusPayload {
        status: "not_found".to_string(),
        created: Vec::new(),
        error: Some("job not found".to_string()),
    }
}

fn to_compact_alnum_upper(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase()
}

fn hash_password(raw_password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(raw_password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| AppError::PasswordHash)
}

fn verify_password(hash: &str, raw_password: &str) -> Result<bool, AppError> {
    let parsed = PasswordHash::new(hash).map_err(|_| AppError::PasswordHash)?;
    Ok(Argon2::default()
        .verify_password(raw_password.as_bytes(), &parsed)
        .is_ok())
}

fn role_can_create(actor_role: &str, target_role: &str) -> bool {
    matches!(
        (actor_role, target_role),
        ("platform_admin", "super_admin")
            | ("super_admin", "department_admin")
            | ("department_admin", "lecturer")
            | ("department_admin", "student")
    )
}

fn role_can_manage_users(actor_role: &str) -> bool {
    matches!(actor_role, "platform_admin" | "super_admin" | "department_admin")
}

fn allowed_user_roles_for_viewer(actor_role: &str) -> Result<Option<Vec<&'static str>>, AppError> {
    match actor_role {
        "platform_admin" => Ok(None),
        "super_admin" => Ok(Some(vec!["super_admin", "department_admin", "lecturer", "student"])),
        "department_admin" => Ok(Some(vec!["lecturer", "student"])),
        "lecturer" | "student" => Ok(Some(vec!["student"])),
        _ => Err(AppError::AccessDenied),
    }
}

fn get_actor_scope(
    conn: &Connection,
    actor_username: &str,
) -> Result<(i64, String, Option<String>, Option<String>, Option<String>), AppError> {
    conn.query_row(
        "SELECT id, role, college_uid, college_name, college_identification_number
         FROM users
         WHERE username = ?1 AND is_active = 1",
        params![actor_username],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        },
    )
    .optional()?
    .ok_or(AppError::ActorNotFound)
}

fn log_outbox(conn: &Connection, table_name: &str, record_id: i64, operation: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO sync_outbox (table_name, record_id, operation, payload, status) VALUES (?1, ?2, ?3, json_object('id', ?2), 'pending')",
        params![table_name, record_id, operation],
    )?;
    Ok(())
}

fn normalize_upper(input: &str) -> String {
    input.trim().to_uppercase()
}

fn get_user_by_username(conn: &Connection, username: &str) -> Result<UserSummary, AppError> {
    conn.query_row(
        "SELECT id, username, full_name, role, department, is_active, created_at FROM users WHERE username = ?1",
        params![username],
        user_row_to_summary,
    )
    .optional()?
    .ok_or(AppError::TargetNotFound)
}

fn get_actor_department(conn: &Connection, actor_username: &str) -> Result<String, AppError> {
    let department: Option<String> = conn
        .query_row(
            "SELECT department FROM users WHERE username = ?1 AND is_active = 1",
            params![normalize_upper(actor_username)],
            |r| r.get(0),
        )
        .optional()?
        .flatten();

    department
        .map(|d| normalize_upper(&d))
        .filter(|d| !d.is_empty())
        .ok_or_else(|| AppError::Validation("actor is not assigned to any department".to_string()))
}

fn derive_department_admin_prefixes(
    conn: &Connection,
    actor_username: &str,
) -> Result<(String, String, String), AppError> {
    let (_, actor_role, actor_college_uid, _, actor_college_identification_number) =
        get_actor_scope(conn, actor_username)?;
    if actor_role != "department_admin" {
        return Err(AppError::AccessDenied);
    }

    let actor_department = get_actor_department(conn, actor_username)?;
    let department_code = to_compact_alnum_upper(&actor_department)
        .chars()
        .take(2)
        .collect::<String>();
    if department_code.len() < 2 {
        return Err(AppError::Validation(
            "department must contain at least two letters or digits".to_string(),
        ));
    }

    let actor_college_uid = actor_college_uid
        .ok_or_else(|| AppError::Validation("actor is not assigned to any college".to_string()))?;
    let college_source = actor_college_identification_number.unwrap_or(actor_college_uid);
    let college_code = to_compact_alnum_upper(&college_source);
    if college_code.is_empty() {
        return Err(AppError::Validation(
            "invalid college identifier for actor".to_string(),
        ));
    }

    Ok((actor_department, college_code, department_code))
}

fn normalize_student_year(raw_year: &str) -> Result<String, AppError> {
    let trimmed = raw_year.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("student year is required".to_string()));
    }

    if !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation(
            "student year must contain only digits".to_string(),
        ));
    }

    match trimmed.len() {
        2 => Ok(trimmed.to_string()),
        4 => Ok(trimmed[2..].to_string()),
        _ => Err(AppError::Validation(
            "student year must be 2 digits (YY) or 4 digits (YYYY)".to_string(),
        )),
    }
}

fn next_username_sequence(
    conn: &Connection,
    prefix: &str,
    width: usize,
    max_seq: i64,
) -> Result<Option<String>, AppError> {
    for idx in 1..=max_seq {
        let candidate = format!("{}{:0width$}", prefix, idx, width = width);
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM users WHERE username = ?1",
                params![candidate],
                |r| r.get(0),
            )
            .optional()?;

        if exists.is_none() {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
}

fn verify_platform_admin_internal_password(
    conn: &Connection,
    actor_username: &str,
    actor_role: &str,
    internal_password: Option<&str>,
) -> Result<(), AppError> {
    if actor_role != "platform_admin" {
        return Ok(());
    }

    let normalized_username = normalize_upper(actor_username);
    let (internal_password_hash, internal_password_required): (Option<String>, i64) = conn
        .query_row(
            "SELECT internal_password_hash, internal_password_required FROM users WHERE username = ?1 AND is_active = 1",
            params![normalized_username],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or(AppError::ActorNotFound)?;

    if internal_password_required == 1 || internal_password_hash.as_deref().unwrap_or_default().is_empty() {
        return Err(AppError::Validation(
            "internal password is not set up for this account".to_string(),
        ));
    }

    let provided = internal_password
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::Validation("internal password is required".to_string()))?;

    if !verify_password(internal_password_hash.as_deref().unwrap_or_default(), provided)? {
        return Err(AppError::Validation("invalid internal password".to_string()));
    }

    Ok(())
}

fn ensure_student_semester_row(conn: &Connection, user_id: i64) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR IGNORE INTO student_semesters (student_user_id, current_semester, sync_state) VALUES (?1, 1, 'local_new')",
        params![user_id],
    )?;
    Ok(())
}

fn sync_state_for_operation(operation: &str) -> &'static str {
    if operation.eq_ignore_ascii_case("delete") {
        "deleted"
    } else {
        "server_new"
    }
}

fn apply_pull_change(conn: &Connection, change: &SyncPullChange) -> Result<(), AppError> {
    let table = change.table_name.as_str();
    let operation = change.operation.as_str();
    let record = &change.record;

    match table {
        "users" => {
            let id = record.get("id").and_then(Value::as_i64).ok_or_else(|| AppError::Json("users.id missing".to_string()))?;
            if operation == "delete" {
                conn.execute(
                    "UPDATE users SET is_active = 0, sync_state = 'deleted', version = version + 1, updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                )?;
                return Ok(());
            }

            let username = record.get("username").and_then(Value::as_str).unwrap_or_default().to_string();
            let password_hash = record
                .get("password_hash")
                .and_then(Value::as_str)
                .unwrap_or("$argon2id$v=19$m=19456,t=2,p=1$bnVsbA$bnVsbA")
                .to_string();
            let role = record.get("role").and_then(Value::as_str).unwrap_or("student").to_string();
            let department = record.get("department").and_then(Value::as_str).map(|s| s.to_string());
            let college_uid = record
                .get("college_uid")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let college_name = record
                .get("college_name")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let college_identification_number = record
                .get("college_identification_number")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let full_name = record
                .get("full_name")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let internal_password_hash = record
                .get("internal_password_hash")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let internal_password_required = if record
                .get("internal_password_required")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                1
            } else {
                0
            };
            let is_active = if record.get("is_active").and_then(Value::as_bool).unwrap_or(true) { 1 } else { 0 };

            conn.execute(
                                "INSERT INTO users (id, username, password_hash, role, department, is_active, college_uid, college_name, college_identification_number, full_name, internal_password_hash, internal_password_required, sync_state)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                   username = excluded.username,
                   role = excluded.role,
                   department = excluded.department,
                   is_active = excluded.is_active,
                   college_uid = excluded.college_uid,
                   college_name = excluded.college_name,
                   college_identification_number = excluded.college_identification_number,
                                     full_name = excluded.full_name,
                   internal_password_hash = excluded.internal_password_hash,
                   internal_password_required = excluded.internal_password_required,
                   version = users.version + 1,
                   sync_state = excluded.sync_state,
                   updated_at = datetime('now')",
                params![
                    id,
                    username,
                    password_hash,
                    role,
                    department,
                    is_active,
                    college_uid,
                    college_name,
                    college_identification_number,
                    full_name,
                    internal_password_hash,
                    internal_password_required,
                    sync_state_for_operation(operation)
                ],
            )?;
        }
        "courses" => {
            let id = record.get("id").and_then(Value::as_i64).ok_or_else(|| AppError::Json("courses.id missing".to_string()))?;
            if operation == "delete" {
                conn.execute(
                    "UPDATE courses SET status = 'ended', sync_state = 'deleted', version = version + 1, updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                )?;
                return Ok(());
            }

            let code = record.get("code").and_then(Value::as_str).unwrap_or_default().to_string();
            let title = record.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
            let lecturer_user_id = record.get("lecturer_user_id").and_then(Value::as_i64).unwrap_or(0);
            let department = record.get("department").and_then(Value::as_str).map(|s| s.to_string());
            let semester = record.get("semester").and_then(Value::as_i64).unwrap_or(1);
            let status = record.get("status").and_then(Value::as_str).unwrap_or("active").to_string();

            conn.execute(
                "INSERT INTO courses (id, code, title, lecturer_user_id, department, semester, status, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   code = excluded.code,
                   title = excluded.title,
                   department = excluded.department,
                   semester = excluded.semester,
                   status = excluded.status,
                   version = courses.version + 1,
                   sync_state = excluded.sync_state,
                   updated_at = datetime('now')",
                params![id, code, title, lecturer_user_id, department, semester, status, sync_state_for_operation(operation)],
            )?;
        }
        "course_members" => {
            let id = record.get("id").and_then(Value::as_i64).ok_or_else(|| AppError::Json("course_members.id missing".to_string()))?;
            if operation == "delete" {
                conn.execute(
                    "UPDATE course_members SET removed_at = datetime('now'), sync_state = 'deleted', version = version + 1 WHERE id = ?1",
                    params![id],
                )?;
                return Ok(());
            }

            let course_id = record.get("course_id").and_then(Value::as_i64).unwrap_or(0);
            let student_user_id = record.get("student_user_id").and_then(Value::as_i64).unwrap_or(0);
            let removal_deadline_at = record.get("removal_deadline_at").and_then(Value::as_str).map(|s| s.to_string());

            conn.execute(
                "INSERT INTO course_members (id, course_id, student_user_id, removal_deadline_at, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   removal_deadline_at = excluded.removal_deadline_at,
                   version = course_members.version + 1,
                   sync_state = excluded.sync_state",
                params![id, course_id, student_user_id, removal_deadline_at, sync_state_for_operation(operation)],
            )?;
        }
        "marks" => {
            let id = record.get("id").and_then(Value::as_i64).ok_or_else(|| AppError::Json("marks.id missing".to_string()))?;
            if operation == "delete" {
                conn.execute("DELETE FROM marks WHERE id = ?1", params![id])?;
                return Ok(());
            }

            let course_id = record.get("course_id").and_then(Value::as_i64).unwrap_or(0);
            let student_user_id = record.get("student_user_id").and_then(Value::as_i64).unwrap_or(0);
            let internal_marks = record.get("internal_marks").and_then(Value::as_i64);
            let external_marks = record.get("external_marks").and_then(Value::as_i64);
            let lecturer_decision = record.get("lecturer_decision").and_then(Value::as_str).map(|s| s.to_string());
            let updated_by = record.get("updated_by").and_then(Value::as_i64).unwrap_or(student_user_id);

            conn.execute(
                "INSERT INTO marks (id, course_id, student_user_id, internal_marks, external_marks, lecturer_decision, updated_by, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   internal_marks = excluded.internal_marks,
                   external_marks = excluded.external_marks,
                   lecturer_decision = excluded.lecturer_decision,
                   updated_by = excluded.updated_by,
                   updated_at = datetime('now'),
                   version = marks.version + 1,
                   sync_state = excluded.sync_state",
                params![id, course_id, student_user_id, internal_marks, external_marks, lecturer_decision, updated_by, sync_state_for_operation(operation)],
            )?;
        }
        "enrollment_requests" => {
            let id = record
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppError::Json("enrollment_requests.id missing".to_string()))?;
            if operation == "delete" {
                conn.execute("DELETE FROM enrollment_requests WHERE id = ?1", params![id])?;
                return Ok(());
            }

            let course_id = record.get("course_id").and_then(Value::as_i64).unwrap_or(0);
            let student_user_id = record.get("student_user_id").and_then(Value::as_i64).unwrap_or(0);
            let status = record
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                .to_string();

            conn.execute(
                "INSERT INTO enrollment_requests (id, course_id, student_user_id, status, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   course_id = excluded.course_id,
                   student_user_id = excluded.student_user_id,
                   status = excluded.status,
                   updated_at = datetime('now'),
                   version = enrollment_requests.version + 1,
                   sync_state = excluded.sync_state",
                params![id, course_id, student_user_id, status, sync_state_for_operation(operation)],
            )?;
        }
        "attendance_records" => {
            let id = record
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppError::Json("attendance_records.id missing".to_string()))?;
            if operation == "delete" {
                conn.execute("DELETE FROM attendance_records WHERE id = ?1", params![id])?;
                return Ok(());
            }

            let course_id = record.get("course_id").and_then(Value::as_i64).unwrap_or(0);
            let student_user_id = record.get("student_user_id").and_then(Value::as_i64).unwrap_or(0);
            let attendance_date = record
                .get("attendance_date")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01")
                .to_string();
            let status = record
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("A")
                .to_string();
            let marked_by = record.get("marked_by").and_then(Value::as_i64).unwrap_or(0);

            conn.execute(
                "INSERT INTO attendance_records (id, course_id, student_user_id, attendance_date, status, marked_by, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   course_id = excluded.course_id,
                   student_user_id = excluded.student_user_id,
                   attendance_date = excluded.attendance_date,
                   status = excluded.status,
                   marked_by = excluded.marked_by,
                   version = attendance_records.version + 1,
                   sync_state = excluded.sync_state",
                params![
                    id,
                    course_id,
                    student_user_id,
                    attendance_date,
                    status,
                    marked_by,
                    sync_state_for_operation(operation)
                ],
            )?;
        }
        "student_semesters" => {
            let student_user_id = record
                .get("student_user_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppError::Json("student_semesters.student_user_id missing".to_string()))?;
            if operation == "delete" {
                conn.execute(
                    "DELETE FROM student_semesters WHERE student_user_id = ?1",
                    params![student_user_id],
                )?;
                return Ok(());
            }

            let current_semester = record
                .get("current_semester")
                .and_then(Value::as_i64)
                .unwrap_or(1);

            conn.execute(
                "INSERT INTO student_semesters (student_user_id, current_semester, sync_state)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(student_user_id) DO UPDATE SET
                   current_semester = excluded.current_semester,
                   updated_at = datetime('now'),
                   version = student_semesters.version + 1,
                   sync_state = excluded.sync_state",
                params![
                    student_user_id,
                    current_semester,
                    sync_state_for_operation(operation)
                ],
            )?;
        }
        "course_progress_log" => {
            let id = record
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppError::Json("course_progress_log.id missing".to_string()))?;
            if operation == "delete" {
                conn.execute("DELETE FROM course_progress_log WHERE id = ?1", params![id])?;
                return Ok(());
            }

            let course_id = record.get("course_id").and_then(Value::as_i64).unwrap_or(0);
            let lecturer_user_id = record
                .get("lecturer_user_id")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let progress_text = record
                .get("progress_text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let progress_date = record
                .get("progress_date")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01")
                .to_string();

            conn.execute(
                "INSERT INTO course_progress_log (id, course_id, lecturer_user_id, progress_text, progress_date, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   course_id = excluded.course_id,
                   lecturer_user_id = excluded.lecturer_user_id,
                   progress_text = excluded.progress_text,
                   progress_date = excluded.progress_date,
                   version = course_progress_log.version + 1,
                   sync_state = excluded.sync_state",
                params![
                    id,
                    course_id,
                    lecturer_user_id,
                    progress_text,
                    progress_date,
                    sync_state_for_operation(operation)
                ],
            )?;
        }
        _ => {
            // Unknown table changes are ignored intentionally to keep client forward-compatible.
        }
    }

    Ok(())
}

fn build_outbox_payload(conn: &Connection, table_name: &str, record_id: i64) -> Result<Option<String>, AppError> {
    let payload = match table_name {
        "users" => conn
            .query_row(
                "SELECT id, username, password_hash, role, department, is_active, college_uid, college_name, college_identification_number, full_name, internal_password_hash, internal_password_required, created_at, updated_at, version, sync_state
                 FROM users WHERE id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "username": r.get::<_, String>(1)?,
                        "password_hash": r.get::<_, String>(2)?,
                        "role": r.get::<_, String>(3)?,
                        "department": r.get::<_, Option<String>>(4)?,
                        "is_active": r.get::<_, i64>(5)? == 1,
                        "college_uid": r.get::<_, Option<String>>(6)?,
                        "college_name": r.get::<_, Option<String>>(7)?,
                        "college_identification_number": r.get::<_, Option<String>>(8)?,
                        "full_name": r.get::<_, Option<String>>(9)?,
                        "internal_password_hash": r.get::<_, Option<String>>(10)?,
                        "internal_password_required": r.get::<_, i64>(11)? == 1,
                        "created_at": r.get::<_, String>(12)?,
                        "updated_at": r.get::<_, String>(13)?,
                        "version": r.get::<_, i64>(14)?,
                        "sync_state": r.get::<_, String>(15)?
                    }))
                },
            )
            .optional()?,
        "courses" => conn
            .query_row(
                "SELECT id, code, title, lecturer_user_id, department, semester, status, end_announced_at, created_at, updated_at, version, sync_state
                 FROM courses WHERE id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "code": r.get::<_, String>(1)?,
                        "title": r.get::<_, String>(2)?,
                        "lecturer_user_id": r.get::<_, i64>(3)?,
                        "department": r.get::<_, Option<String>>(4)?,
                        "semester": r.get::<_, i64>(5)?,
                        "status": r.get::<_, String>(6)?,
                        "end_announced_at": r.get::<_, Option<String>>(7)?,
                        "created_at": r.get::<_, String>(8)?,
                        "updated_at": r.get::<_, String>(9)?,
                        "version": r.get::<_, i64>(10)?,
                        "sync_state": r.get::<_, String>(11)?
                    }))
                },
            )
            .optional()?,
        "enrollment_requests" => conn
            .query_row(
                "SELECT id, course_id, student_user_id, status, created_at, updated_at, version, sync_state
                 FROM enrollment_requests WHERE id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "course_id": r.get::<_, i64>(1)?,
                        "student_user_id": r.get::<_, i64>(2)?,
                        "status": r.get::<_, String>(3)?,
                        "created_at": r.get::<_, String>(4)?,
                        "updated_at": r.get::<_, String>(5)?,
                        "version": r.get::<_, i64>(6)?,
                        "sync_state": r.get::<_, String>(7)?
                    }))
                },
            )
            .optional()?,
        "course_members" => conn
            .query_row(
                "SELECT id, course_id, student_user_id, joined_at, removed_at, removal_deadline_at, version, sync_state
                 FROM course_members WHERE id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "course_id": r.get::<_, i64>(1)?,
                        "student_user_id": r.get::<_, i64>(2)?,
                        "joined_at": r.get::<_, String>(3)?,
                        "removed_at": r.get::<_, Option<String>>(4)?,
                        "removal_deadline_at": r.get::<_, Option<String>>(5)?,
                        "version": r.get::<_, i64>(6)?,
                        "sync_state": r.get::<_, String>(7)?
                    }))
                },
            )
            .optional()?,
        "attendance_records" => conn
            .query_row(
                "SELECT id, course_id, student_user_id, attendance_date, status, marked_by, created_at, version, sync_state
                 FROM attendance_records WHERE id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "course_id": r.get::<_, i64>(1)?,
                        "student_user_id": r.get::<_, i64>(2)?,
                        "attendance_date": r.get::<_, String>(3)?,
                        "status": r.get::<_, String>(4)?,
                        "marked_by": r.get::<_, i64>(5)?,
                        "created_at": r.get::<_, String>(6)?,
                        "version": r.get::<_, i64>(7)?,
                        "sync_state": r.get::<_, String>(8)?
                    }))
                },
            )
            .optional()?,
        "marks" => conn
            .query_row(
                "SELECT id, course_id, student_user_id, internal_marks, external_marks, lecturer_decision, updated_by, updated_at, version, sync_state
                 FROM marks WHERE id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "course_id": r.get::<_, i64>(1)?,
                        "student_user_id": r.get::<_, i64>(2)?,
                        "internal_marks": r.get::<_, Option<i64>>(3)?,
                        "external_marks": r.get::<_, Option<i64>>(4)?,
                        "lecturer_decision": r.get::<_, Option<String>>(5)?,
                        "updated_by": r.get::<_, i64>(6)?,
                        "updated_at": r.get::<_, String>(7)?,
                        "version": r.get::<_, i64>(8)?,
                        "sync_state": r.get::<_, String>(9)?
                    }))
                },
            )
            .optional()?,
        "student_semesters" => conn
            .query_row(
                "SELECT student_user_id, current_semester, updated_at, version, sync_state
                 FROM student_semesters WHERE student_user_id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "student_user_id": r.get::<_, i64>(0)?,
                        "current_semester": r.get::<_, i64>(1)?,
                        "updated_at": r.get::<_, String>(2)?,
                        "version": r.get::<_, i64>(3)?,
                        "sync_state": r.get::<_, String>(4)?
                    }))
                },
            )
            .optional()?,
        "course_progress_log" => conn
            .query_row(
                "SELECT id, course_id, lecturer_user_id, progress_text, progress_date, created_at, version, sync_state
                 FROM course_progress_log WHERE id = ?1",
                params![record_id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "course_id": r.get::<_, i64>(1)?,
                        "lecturer_user_id": r.get::<_, i64>(2)?,
                        "progress_text": r.get::<_, String>(3)?,
                        "progress_date": r.get::<_, String>(4)?,
                        "created_at": r.get::<_, String>(5)?,
                        "version": r.get::<_, i64>(6)?,
                        "sync_state": r.get::<_, String>(7)?
                    }))
                },
            )
            .optional()?,
        _ => None,
    };

    Ok(payload.map(|v| v.to_string()))
}

#[tauri::command]
fn seed_full_sync_snapshot(app: tauri::AppHandle) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;

    let seeded: String = conn.query_row(
        "SELECT value FROM sync_metadata WHERE key = 'full_snapshot_seeded'",
        [],
        |r| r.get(0),
    )?;
    if seeded == "1" {
        return Ok(false);
    }

    let table_specs = vec![
        ("users", "id"),
        ("courses", "id"),
        ("enrollment_requests", "id"),
        ("course_members", "id"),
        ("attendance_records", "id"),
        ("marks", "id"),
        ("student_semesters", "student_user_id"),
        ("course_progress_log", "id"),
    ];

    for (table, id_col) in table_specs {
        let sql = format!("SELECT {} FROM {}", id_col, table);
        let mut stmt = conn.prepare(&sql)?;
        let ids = stmt
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        for record_id in ids {
            conn.execute(
                "INSERT INTO sync_outbox (table_name, record_id, operation, payload, status)
                 VALUES (?1, ?2, 'update', json_object('id', ?2), 'pending')",
                params![table, record_id],
            )?;
        }
    }

    conn.execute(
        "UPDATE sync_metadata SET value = '1', updated_at = datetime('now') WHERE key = 'full_snapshot_seeded'",
        [],
    )?;

    Ok(true)
}

fn collect_pending_outbox(conn: &Connection, limit: i64) -> Result<Vec<OutboxRecord>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, table_name, record_id, operation, payload, created_at, retries
         FROM sync_outbox
         WHERE status IN ('pending', 'failed')
         ORDER BY id ASC
         LIMIT ?1",
    )?;

    let mut rows = stmt.query(params![limit])?;
    let mut out: Vec<OutboxRecord> = Vec::new();

    while let Some(r) = rows.next()? {
        let outbox_id: i64 = r.get(0)?;
        let table_name: String = r.get(1)?;
        let record_id: i64 = r.get(2)?;
        let operation: String = r.get(3)?;
        let fallback_payload: String = r.get(4)?;
        let created_at: String = r.get(5)?;
        let retries: i64 = r.get(6)?;

        let payload = build_outbox_payload(conn, &table_name, record_id)?.unwrap_or(fallback_payload);

        out.push(OutboxRecord {
            outbox_id,
            table_name,
            record_id,
            operation,
            payload,
            created_at,
            retries,
        });
    }

    Ok(out)
}

fn mark_outbox_sent(conn: &Connection, ids: &[i64]) -> Result<(), AppError> {
    for id in ids {
        conn.execute(
            "UPDATE sync_outbox SET status = 'sent' WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

fn mark_outbox_failed(conn: &Connection, rejected: &[SyncRejectedItem]) -> Result<(), AppError> {
    for item in rejected {
        let _ = &item.reason;
        conn.execute(
            "UPDATE sync_outbox
             SET retries = retries + 1,
                 status = CASE WHEN retries + 1 >= 3 THEN 'failed' ELSE 'pending' END
             WHERE id = ?1",
            params![item.outbox_id],
        )?;
    }
    Ok(())
}

#[tauri::command]
fn process_outbox_and_sync(
    app: tauri::AppHandle,
    server_base_url: Option<String>,
    auth_token: Option<String>,
    batch_size: Option<i64>,
    actor_username: Option<String>,
    actor_role: Option<String>,
    dry_run: bool,
) -> Result<SyncProcessResult, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;

    let batch = batch_size.unwrap_or(100).max(1);
    let pending = collect_pending_outbox(&conn, batch)?;
    let payload = SyncPushRequest {
        client_id: "stu-ls-desktop".to_string(),
        sent_at: Utc::now().to_rfc3339(),
        actor_username,
        actor_role: actor_role.clone(),
        records: pending.clone(),
    };
    let payload_preview = serde_json::to_string_pretty(&payload)
        .map_err(|e| AppError::Json(format!("serialize payload failed: {e}")))?;

    let is_student_pull = actor_role
        .as_deref()
        .map(|r| r.eq_ignore_ascii_case("student"))
        .unwrap_or(false);

    if pending.is_empty() && !is_student_pull {
        return Ok(SyncProcessResult {
            mode: "idle".to_string(),
            queued: 0,
            pushed: 0,
            failed: 0,
            pulled: 0,
            update_available: false,
            notifications_count: 0,
            payload_preview,
        });
    }

    if dry_run || server_base_url.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        return Ok(SyncProcessResult {
            mode: "dry_run".to_string(),
            queued: pending.len() as i64,
            pushed: 0,
            failed: 0,
            pulled: 0,
            update_available: false,
            notifications_count: 0,
            payload_preview,
        });
    }

    let base = server_base_url.unwrap_or_default().trim_end_matches('/').to_string();
    let endpoint = format!("{}/sync/bridge", base);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Http(format!("client build failed: {e}")))?;

    let mut request = client.post(endpoint).json(&payload);
    if let Some(token) = auth_token {
        if !token.trim().is_empty() {
            request = request.bearer_auth(token);
        }
    }

    let response = request
        .send()
        .map_err(|e| AppError::Http(format!("sync request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::Http(format!(
            "sync server returned status {}",
            response.status()
        )));
    }

    let server_response: SyncServerResponse = response
        .json()
        .map_err(|e| AppError::Json(format!("invalid sync response: {e}")))?;

    mark_outbox_sent(&conn, &server_response.accepted_outbox_ids)?;
    mark_outbox_failed(&conn, &server_response.rejected)?;

    for change in &server_response.pull_changes {
        apply_pull_change(&conn, change)?;
    }

    conn.execute(
        "UPDATE sync_metadata SET value = ?1, updated_at = datetime('now') WHERE key = 'last_successful_sync_at'",
        params![Utc::now().to_rfc3339()],
    )?;
    conn.execute(
        "UPDATE sync_metadata SET value = ?1, updated_at = datetime('now') WHERE key = 'last_push_batch_size'",
        params![payload.records.len().to_string()],
    )?;

    Ok(SyncProcessResult {
        mode: "online".to_string(),
        queued: payload.records.len() as i64,
        pushed: server_response.accepted_outbox_ids.len() as i64,
        failed: server_response.rejected.len() as i64,
        pulled: server_response.pull_changes.len() as i64,
        update_available: server_response.update_available,
        notifications_count: server_response.notifications.len() as i64,
        payload_preview,
    })
}

fn get_actor(conn: &Connection, actor_username: &str) -> Result<(i64, String), AppError> {
    conn.query_row(
        "SELECT id, role FROM users WHERE username = ?1 AND is_active = 1",
        params![actor_username],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()?
    .ok_or(AppError::ActorNotFound)
}

fn user_row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserSummary> {
    Ok(UserSummary {
        id: row.get(0)?,
        username: row.get(1)?,
        full_name: row.get(2)?,
        role: row.get(3)?,
        department: row.get(4)?,
        is_active: row.get::<_, i64>(5)? == 1,
        created_at: row.get(6)?,
    })
}

#[tauri::command]
fn initialize_system(app: tauri::AppHandle) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;
    // Startup should be non-destructive; keep existing local users/data intact.
    Ok(true)
}

#[tauri::command]
fn seed_platform_admin(
    app: tauri::AppHandle,
    username: String,
    password: String,
) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;

    let normalized_username = normalize_upper(&username);
    let existing_count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if existing_count > 0 {
        let user = conn.query_row(
            "SELECT id, username, full_name, role, department, is_active, created_at FROM users WHERE username = ?1",
            params![normalized_username],
            user_row_to_summary,
        ).optional()?;

        return user.ok_or(AppError::UserAlreadyExists);
    }

    let password_hash = hash_password(&password)?;
    conn.execute(
        "INSERT INTO users (username, password_hash, role, department, internal_password_hash, internal_password_required, sync_state) VALUES (?1, ?2, 'platform_admin', NULL, NULL, 1, 'local_new')",
        params![normalized_username, password_hash],
    )?;

    let created_id = conn.last_insert_rowid();
    let created = conn.query_row(
        "SELECT id, username, full_name, role, department, is_active, created_at FROM users WHERE id = ?1",
        params![created_id],
        user_row_to_summary,
    )?;
    Ok(created)
}

#[tauri::command]
fn login(app: tauri::AppHandle, username: String, password: String) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;

    authenticate_login(&conn, &username, &password, &[])
}

fn authenticate_login(
    conn: &Connection,
    username: &str,
    password: &str,
    allowed_roles: &[&str],
) -> Result<UserSummary, AppError> {
    apply_migration(conn)?;
    let normalized_username = normalize_upper(username);

    let row = conn
        .query_row(
            "SELECT id, username, full_name, role, department, is_active, created_at, password_hash FROM users WHERE username = ?1 AND is_active = 1",
            params![normalized_username],
            |r| {
                Ok((
                    UserSummary {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        full_name: r.get(2)?,
                        role: r.get(3)?,
                        department: r.get(4)?,
                        is_active: r.get::<_, i64>(5)? == 1,
                        created_at: r.get(6)?,
                    },
                    r.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?
        .ok_or(AppError::InvalidCredentials)?;

    let (summary, hash) = row;
    if !verify_password(&hash, &password)? {
        return Err(AppError::InvalidCredentials);
    }

    if !allowed_roles.is_empty() && !allowed_roles.iter().any(|role| *role == summary.role) {
        return Err(AppError::InvalidCredentials);
    }

    Ok(summary)
}

#[tauri::command]
fn login_student(app: tauri::AppHandle, username: String, password: String) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    authenticate_login(&conn, &username, &password, &["student"])
}

#[tauri::command]
fn login_admin(app: tauri::AppHandle, username: String, password: String) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    authenticate_login(&conn, &username, &password, &["super_admin", "department_admin"])
}

#[tauri::command]
fn login_lecturer(app: tauri::AppHandle, username: String, password: String) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    authenticate_login(&conn, &username, &password, &["lecturer"])
}

#[tauri::command]
fn login_platform_admin(app: tauri::AppHandle, username: String, password: String) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    authenticate_login(&conn, &username, &password, &["platform_admin"])
}

#[tauri::command]
fn create_user(
    app: tauri::AppHandle,
    actor_username: String,
    username: String,
    password: String,
    role: String,
    department: Option<String>,
    full_name: Option<String>,
    college_name: Option<String>,
    college_identification_number: Option<String>,
    internal_password: Option<String>,
    sync_server_url: Option<String>,
    sync_token: Option<String>,
) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, actor_role, actor_college_uid, actor_college_name, actor_college_identification_number) =
        get_actor_scope(&conn, &actor_username)?;

    if !role_can_create(&actor_role, &role) {
        return Err(AppError::InvalidRoleTransition);
    }
    verify_platform_admin_internal_password(
        &conn,
        &actor_username,
        &actor_role,
        internal_password.as_deref(),
    )?;

    let (target_college_uid, target_college_name, target_college_identification_number) =
        if actor_role == "platform_admin" && role == "super_admin" {
            let cname = college_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| AppError::Validation("college name is required for super_admin creation".to_string()))?
                .to_string();

            let cid = college_identification_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| AppError::Validation(
                    "college identification number is required for super_admin creation".to_string(),
                ))?
                .to_string();

            let existing_uid: Option<String> = conn
                .query_row(
                    "SELECT college_uid FROM users WHERE college_identification_number = ?1 AND college_uid IS NOT NULL LIMIT 1",
                    params![cid.clone()],
                    |r| r.get(0),
                )
                .optional()?;

            (existing_uid.unwrap_or_else(generate_college_uid), Some(cname), Some(cid))
        } else {
            let cuid = actor_college_uid.ok_or_else(|| {
                AppError::Validation("actor is not assigned to any college".to_string())
            })?;
            (
                cuid,
                actor_college_name,
                actor_college_identification_number,
            )
        };

    let mut effective_department = department;
    if actor_role == "department_admin" {
        let actor_department = get_actor_department(&conn, &actor_username)?;
        if let Some(ref provided_department) = effective_department {
            let normalized_provided_department = normalize_upper(provided_department);
            if normalized_provided_department != actor_department {
                return Err(AppError::Validation(
                    "department_admin can only create users in their own department".to_string(),
                ));
            }
        }
        if role == "lecturer" || role == "student" {
            effective_department = Some(actor_department);
        }
    }

    let created = user_repository::save_new_user_online_first(
        &conn,
        sync_server_url.as_deref(),
        sync_token.as_deref(),
        &username,
        &password,
        &role,
        effective_department.as_deref(),
        Some(target_college_uid.as_str()),
        target_college_name.as_deref(),
        target_college_identification_number.as_deref(),
        full_name.as_deref(),
    )?;

    conn.execute(
        "INSERT INTO audit_log (actor_username, action, metadata_json) VALUES (?1, 'create_user', json_object('created_user_id', ?2, 'actor_id', ?3))",
        params![actor_username, created.id, actor_id],
    )?;

    Ok(created)
}

#[tauri::command]
fn create_department_admin_with_unique_number(
    app: tauri::AppHandle,
    actor_username: String,
    department: String,
    sync_server_url: Option<String>,
    sync_token: Option<String>,
) -> Result<CredentialRow, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, actor_college_uid, actor_college_name, actor_college_identification_number) =
        get_actor_scope(&conn, &actor_username)?;

    if actor_role != "super_admin" {
        return Err(AppError::AccessDenied);
    }

    let actor_college_uid = actor_college_uid
        .ok_or_else(|| AppError::Validation("actor is not assigned to any college".to_string()))?;

    let canonical_department = normalize_upper(&department);
    if canonical_department.is_empty() {
        return Err(AppError::Validation("department is required".to_string()));
    }
    let dept_code: String = canonical_department
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(2)
        .collect::<String>()
        .to_uppercase();
    if dept_code.len() < 2 {
        return Err(AppError::Validation(
            "department must contain at least two letters or digits".to_string(),
        ));
    }

    let college_source = actor_college_identification_number
        .clone()
        .unwrap_or_else(|| actor_college_uid.clone());
    let canonical_college = to_compact_alnum_upper(&college_source);
    if canonical_college.is_empty() {
        return Err(AppError::Validation("invalid college identifier for actor".to_string()));
    }

    let mut generated_username: Option<String> = None;
    for idx in 1..=9999 {
        let candidate = format!("{}{}AD{:03}", canonical_college, dept_code, idx);
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM users WHERE username = ?1",
                params![candidate],
                |r| r.get(0),
            )
            .optional()?;

        if exists.is_none() {
            generated_username = Some(candidate);
            break;
        }
    }

    let generated_username = generated_username.ok_or_else(|| {
        AppError::Validation("unable to generate department admin unique number".to_string())
    })?;

    // Planned format: college + department + AD + 3-digit sequence.
    user_repository::save_new_user_online_first(
        &conn,
        sync_server_url.as_deref(),
        sync_token.as_deref(),
        &generated_username,
        &generated_username,
        "department_admin",
        Some(canonical_department.as_str()),
        Some(actor_college_uid.as_str()),
        actor_college_name.as_deref(),
        actor_college_identification_number.as_deref(),
        None,
    )?;

    Ok(CredentialRow {
        username: generated_username.clone(),
        password: generated_username,
        full_name: None,
    })
}

#[tauri::command]
fn create_lecturer_with_unique_number(
    app: tauri::AppHandle,
    actor_username: String,
    sync_server_url: Option<String>,
    sync_token: Option<String>,
) -> Result<CredentialRow, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, actor_college_uid, actor_college_name, actor_college_identification_number) =
        get_actor_scope(&conn, &actor_username)?;
    if actor_role != "department_admin" {
        return Err(AppError::AccessDenied);
    }

    let actor_department = get_actor_department(&conn, &actor_username)?;
    let dept_code = to_compact_alnum_upper(&actor_department)
        .chars()
        .take(2)
        .collect::<String>();
    if dept_code.len() < 2 {
        return Err(AppError::Validation(
            "department must contain at least two letters or digits".to_string(),
        ));
    }

    let actor_college_uid = actor_college_uid
        .ok_or_else(|| AppError::Validation("actor is not assigned to any college".to_string()))?;
    let college_source = actor_college_identification_number
        .clone()
        .unwrap_or_else(|| actor_college_uid.clone());
    let college_code = to_compact_alnum_upper(&college_source);
    if college_code.is_empty() {
        return Err(AppError::Validation("invalid college identifier for actor".to_string()));
    }

    let username_prefix = format!("{}{}LS", college_code, dept_code);
    let username = next_username_sequence(&conn, &username_prefix, 3, 999)?
        .ok_or_else(|| AppError::Validation("unable to generate lecturer unique number".to_string()))?;

    user_repository::save_new_user_online_first(
        &conn,
        sync_server_url.as_deref(),
        sync_token.as_deref(),
        &username,
        &username,
        "lecturer",
        Some(actor_department.as_str()),
        Some(actor_college_uid.as_str()),
        actor_college_name.as_deref(),
        actor_college_identification_number.as_deref(),
        None,
    )?;

    Ok(CredentialRow {
        username: username.clone(),
        password: username,
        full_name: None,
    })
}

#[tauri::command]
fn update_user(
    app: tauri::AppHandle,
    actor_username: String,
    target_username: String,
    new_password: Option<String>,
    new_department: Option<String>,
    is_active: Option<bool>,
    internal_password: Option<String>,
) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role) = get_actor(&conn, &actor_username)?;
    if !role_can_manage_users(&actor_role) {
        return Err(AppError::AccessDenied);
    }
    verify_platform_admin_internal_password(
        &conn,
        &actor_username,
        &actor_role,
        internal_password.as_deref(),
    )?;

    let target = get_user_by_username(&conn, &normalize_upper(&target_username))?;

    if let Some(password) = new_password {
        let password_hash = hash_password(&password)?;
        conn.execute(
            "UPDATE users SET password_hash = ?1, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?2",
            params![password_hash, target.id],
        )?;
    }

    if let Some(department) = new_department {
        conn.execute(
            "UPDATE users SET department = ?1, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?2",
            params![department, target.id],
        )?;
    }

    if let Some(active) = is_active {
        conn.execute(
            "UPDATE users SET is_active = ?1, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?2",
            params![if active { 1 } else { 0 }, target.id],
        )?;
    }

    log_outbox(&conn, "users", target.id, "update")?;
    get_user_by_username(&conn, &target.username)
}

#[tauri::command]
fn delete_user(
    app: tauri::AppHandle,
    actor_username: String,
    target_username: String,
    internal_password: Option<String>,
) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;
    let (_, actor_role) = get_actor(&conn, &actor_username)?;
    if !role_can_manage_users(&actor_role) {
        return Err(AppError::AccessDenied);
    }
    verify_platform_admin_internal_password(
        &conn,
        &actor_username,
        &actor_role,
        internal_password.as_deref(),
    )?;

    let normalized_username = normalize_upper(&target_username);
    let target = get_user_by_username(&conn, &normalized_username)?;
    
    // Check if user is already deleted/inactive
    if !target.is_active {
        return Err(AppError::Validation(
            format!("User '{}' does not exist or has already been deleted.", normalized_username)
        ));
    }
    
    if target.role == "student" {
        conn.execute(
            "DELETE FROM student_lecturer_relationships WHERE student_id IN (SELECT id FROM students WHERE user_id = ?1)",
            params![target.id],
        )?;
        conn.execute(
            "DELETE FROM student_admin_relationships WHERE student_id IN (SELECT id FROM students WHERE user_id = ?1)",
            params![target.id],
        )?;
        conn.execute(
            "DELETE FROM students WHERE user_id = ?1",
            params![target.id],
        )?;
    }

    conn.execute(
        "UPDATE users SET is_active = 0, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?1",
        params![target.id],
    )?;
    log_outbox(&conn, "users", target.id, "update")?;
    Ok(true)
}

#[tauri::command]
fn is_internal_password_setup_required(
    app: tauri::AppHandle,
    username: String,
) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;
    let normalized_username = normalize_upper(&username);

    let required: i64 = conn
        .query_row(
            "SELECT internal_password_required FROM users WHERE username = ?1 AND is_active = 1",
            params![normalized_username],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(AppError::ActorNotFound)?;

    Ok(required == 1)
}

#[tauri::command]
fn set_internal_password(
    app: tauri::AppHandle,
    username: String,
    internal_password: String,
    confirm_password: String,
) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;

    let normalized_username = normalize_upper(&username);
    let trimmed_password = internal_password.trim();
    let trimmed_confirm = confirm_password.trim();

    if trimmed_password.is_empty() {
        return Err(AppError::Validation("internal password is required".to_string()));
    }
    if trimmed_password.len() < 4 {
        return Err(AppError::Validation(
            "internal password must be at least 4 characters".to_string(),
        ));
    }
    if trimmed_password != trimmed_confirm {
        return Err(AppError::Validation("internal password confirmation does not match".to_string()));
    }

    let user_id: i64 = conn
        .query_row(
            "SELECT id FROM users WHERE username = ?1 AND is_active = 1",
            params![normalized_username],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(AppError::ActorNotFound)?;

    let password_hash = hash_password(trimmed_password)?;
    conn.execute(
        "UPDATE users SET internal_password_hash = ?1, internal_password_required = 0, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?2",
        params![password_hash, user_id],
    )?;
    log_outbox(&conn, "users", user_id, "update")?;
    Ok(true)
}

#[tauri::command]
fn prune_local_data_for_actor(app: tauri::AppHandle, actor_username: String) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;

    let _ = actor_username;
    // Keep login non-destructive. Visibility should be controlled by role-based queries,
    // not by deleting local records during sign-in.
    Ok(false)
}

#[tauri::command]
fn bulk_create_lecturers(
    app: tauri::AppHandle,
    actor_username: String,
    lecturer_count: i64,
) -> Result<Vec<CredentialRow>, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, actor_college_uid, actor_college_name, actor_college_identification_number) =
        get_actor_scope(&conn, &actor_username)?;
    if actor_role != "department_admin" {
        return Err(AppError::AccessDenied);
    }

    if lecturer_count <= 0 {
        return Err(AppError::Validation(
            "lecturer count must be greater than zero".to_string(),
        ));
    }
    if lecturer_count > 5000 {
        return Err(AppError::Validation(
            "lecturer count too large: maximum 5000 per request".to_string(),
        ));
    }

    let (actor_department, canonical_college, actor_dept_code) =
        derive_department_admin_prefixes(&conn, &actor_username)?;

    let actor_college_uid = actor_college_uid
        .ok_or_else(|| AppError::Validation("actor is not assigned to any college".to_string()))?;

    let mut created: Vec<CredentialRow> = Vec::new();
    let username_prefix = format!("{}{}LS", canonical_college, actor_dept_code);

    for _ in 1..=lecturer_count {
        let username = next_username_sequence(&conn, &username_prefix, 3, 999)?
            .ok_or_else(|| AppError::Validation("unable to generate lecturer unique number".to_string()))?;

        let _created = user_repository::save_new_user_online_first(
            &conn,
            None,
            None,
            &username,
            &username,
            "lecturer",
            Some(actor_department.as_str()),
            Some(actor_college_uid.as_str()),
            actor_college_name.as_deref(),
            actor_college_identification_number.as_deref(),
            None,
        )?;
        created.push(CredentialRow {
            username: username.clone(),
            password: username,
            full_name: None,
        });
    }

    Ok(created)
}

#[tauri::command]
fn bulk_create_students_from_usns(
    app: tauri::AppHandle,
    actor_username: String,
    usns: Vec<String>,
) -> Result<Vec<CredentialRow>, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, actor_role, actor_college_uid, actor_college_name, actor_college_identification_number) =
        get_actor_scope(&conn, &actor_username)?;
    if actor_role != "department_admin" {
        return Err(AppError::AccessDenied);
    }

    let actor_department = get_actor_department(&conn, &actor_username)?;
    let actor_college_uid = actor_college_uid
        .ok_or_else(|| AppError::Validation("actor is not assigned to any college".to_string()))?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut created: Vec<CredentialRow> = Vec::new();
    for usn in usns {
        let username = normalize_upper(&usn);
        if username.is_empty() {
            continue;
        }
        if !seen.insert(username.clone()) {
            continue;
        }

        let created_user = user_repository::save_new_user_online_first(
            &conn,
            None,
            None,
            &username,
            &username,
            "student",
            Some(actor_department.as_str()),
            Some(actor_college_uid.as_str()),
            actor_college_name.as_deref(),
            actor_college_identification_number.as_deref(),
            None,
        );

        if let Ok(user_summary) = created_user {
            // Create student record with relationships
            let _ = student_repository::insert_student(
                &conn,
                user_summary.id,
                &actor_department,
                &actor_college_uid,
                actor_college_name.as_deref(),
                actor_college_identification_number.as_deref(),
                actor_id,
                None,
                None,
            );

            created.push(CredentialRow {
                username: username.clone(),
                password: username,
                full_name: None,
            });
        } else if matches!(created_user, Err(AppError::UserAlreadyExists)) {
            continue;
        } else {
            created_user?;
        }
    }

    Ok(created)
}

#[tauri::command]
fn bulk_create_students_by_range(
    app: tauri::AppHandle,
    actor_username: String,
    student_year: String,
    from_number: i64,
    to_number: i64,
    pad_width: i64,
) -> Result<Vec<CredentialRow>, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, actor_role, actor_college_uid, actor_college_name, actor_college_identification_number) =
        get_actor_scope(&conn, &actor_username)?;
    if actor_role != "department_admin" {
        return Err(AppError::AccessDenied);
    }

    if from_number <= 0 || to_number <= 0 || to_number < from_number {
        return Err(AppError::Validation(
            "invalid range: use positive numbers and ensure from <= to".to_string(),
        ));
    }
    let total = to_number - from_number + 1;
    if total > 5000 {
        return Err(AppError::Validation(
            "range too large: maximum 5000 students per request".to_string(),
        ));
    }

    let (_, college_code, dept_code) = derive_department_admin_prefixes(&conn, &actor_username)?;
    let year_code = normalize_student_year(&student_year)?;
    let normalized_prefix = format!("{}{}{}", college_code, year_code, dept_code);

    let width = if pad_width <= 0 { 3 } else { pad_width as usize };
    let actor_department = get_actor_department(&conn, &actor_username)?;
    let actor_college_uid = actor_college_uid
        .ok_or_else(|| AppError::Validation("actor is not assigned to any college".to_string()))?;

    let mut created: Vec<CredentialRow> = Vec::new();
    for seq in from_number..=to_number {
        let username = format!("{}{:0width$}", normalized_prefix, seq, width = width);
        let created_user = user_repository::save_new_user_online_first(
            &conn,
            None,
            None,
            &username,
            &username,
            "student",
            Some(actor_department.as_str()),
            Some(actor_college_uid.as_str()),
            actor_college_name.as_deref(),
            actor_college_identification_number.as_deref(),
            None,
        );

        if let Ok(user_summary) = created_user {
            // Create student record with relationships
            let _ = student_repository::insert_student(
                &conn,
                user_summary.id,
                &actor_department,
                &actor_college_uid,
                actor_college_name.as_deref(),
                actor_college_identification_number.as_deref(),
                actor_id,
                None,
                None,
            );

            created.push(CredentialRow {
                username: username.clone(),
                password: username,
                full_name: None,
            });
        } else if matches!(created_user, Err(AppError::UserAlreadyExists)) {
            continue;
        } else {
            created_user?;
        }
    }

    Ok(created)
}

#[tauri::command]
fn start_bulk_create_lecturers_job(
    app: tauri::AppHandle,
    actor_username: String,
    lecturer_count: i64,
) -> Result<String, AppError> {
    let job_id = create_bulk_job_id("bulk-lecturers");
    set_bulk_job_state(&job_id, BulkJobState::queued());

    let app_handle = app.clone();
    let job_id_for_thread = job_id.clone();
    thread::spawn(move || {
        set_bulk_job_state(&job_id_for_thread, BulkJobState::running());
        let result = bulk_create_lecturers(app_handle, actor_username, lecturer_count);
        match result {
            Ok(created) => set_bulk_job_state(&job_id_for_thread, BulkJobState::completed(created)),
            Err(e) => set_bulk_job_state(&job_id_for_thread, BulkJobState::failed(e.to_string())),
        }
    });

    Ok(job_id)
}

#[tauri::command]
fn start_bulk_create_students_from_usns_job(
    app: tauri::AppHandle,
    actor_username: String,
    usns: Vec<String>,
) -> Result<String, AppError> {
    let job_id = create_bulk_job_id("bulk-students-usns");
    set_bulk_job_state(&job_id, BulkJobState::queued());

    let app_handle = app.clone();
    let job_id_for_thread = job_id.clone();
    thread::spawn(move || {
        set_bulk_job_state(&job_id_for_thread, BulkJobState::running());
        let result = bulk_create_students_from_usns(app_handle, actor_username, usns);
        match result {
            Ok(created) => set_bulk_job_state(&job_id_for_thread, BulkJobState::completed(created)),
            Err(e) => set_bulk_job_state(&job_id_for_thread, BulkJobState::failed(e.to_string())),
        }
    });

    Ok(job_id)
}

#[tauri::command]
fn start_bulk_create_students_by_range_job(
    app: tauri::AppHandle,
    actor_username: String,
    student_year: String,
    from_number: i64,
    to_number: i64,
    pad_width: i64,
) -> Result<String, AppError> {
    let job_id = create_bulk_job_id("bulk-students-range");
    set_bulk_job_state(&job_id, BulkJobState::queued());

    let app_handle = app.clone();
    let job_id_for_thread = job_id.clone();
    thread::spawn(move || {
        set_bulk_job_state(&job_id_for_thread, BulkJobState::running());
        let result = bulk_create_students_by_range(
            app_handle,
            actor_username,
            student_year,
            from_number,
            to_number,
            pad_width,
        );
        match result {
            Ok(created) => set_bulk_job_state(&job_id_for_thread, BulkJobState::completed(created)),
            Err(e) => set_bulk_job_state(&job_id_for_thread, BulkJobState::failed(e.to_string())),
        }
    });

    Ok(job_id)
}

#[tauri::command]
fn get_bulk_job_status(job_id: String) -> Result<BulkJobStatusPayload, AppError> {
    Ok(get_bulk_job_state(&job_id))
}

#[tauri::command]
fn get_department_admin_bulk_defaults(
    app: tauri::AppHandle,
    actor_username: String,
) -> Result<DepartmentAdminBulkDefaults, AppError> {
    let conn = open_connection(&app)?;
    let (_department, college_code, department_code) =
        derive_department_admin_prefixes(&conn, &actor_username)?;

    Ok(DepartmentAdminBulkDefaults {
        college_code: college_code.clone(),
        department_code: department_code.clone(),
        lecturer_prefix: format!("{}{}LS", college_code, department_code),
        student_prefix: format!("{}YY{}", college_code, department_code),
    })
}

#[tauri::command]
fn update_my_profile_name(
    app: tauri::AppHandle,
    actor_username: String,
    full_name: String,
) -> Result<UserSummary, AppError> {
    let conn = open_connection(&app)?;
    let normalized_actor = normalize_upper(&actor_username);
    let cleaned_name = full_name.trim();
    if cleaned_name.is_empty() {
        return Err(AppError::Validation("name is required".to_string()));
    }

    let user_id: i64 = conn
        .query_row(
            "SELECT id FROM users WHERE username = ?1 AND is_active = 1",
            params![normalized_actor],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(AppError::ActorNotFound)?;

    conn.execute(
        "UPDATE users SET full_name = ?1, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?2",
        params![cleaned_name, user_id],
    )?;
    log_outbox(&conn, "users", user_id, "update")?;

    conn.query_row(
        "SELECT id, username, full_name, role, department, is_active, created_at FROM users WHERE id = ?1",
        params![user_id],
        user_row_to_summary,
    )
    .map_err(AppError::from)
}

#[tauri::command]
fn list_users(
    app: tauri::AppHandle,
    actor_username: String,
    role_filter: Option<String>,
) -> Result<Vec<UserSummary>, AppError> {
    let conn = open_connection(&app)?;
    apply_migration(&conn)?;
    let (_, actor_role, actor_college_uid, _, _) = get_actor_scope(&conn, &actor_username)?;
    let allowed_roles = allowed_user_roles_for_viewer(&actor_role)?;

    let rows_with_scope: Vec<(UserSummary, Option<String>)> = if let Some(role) = role_filter {
        if let Some(ref allowed) = allowed_roles {
            if !allowed.iter().any(|r| *r == role) {
                return Err(AppError::AccessDenied);
            }
        }

        let mut stmt = conn.prepare(
              "SELECT id, username, full_name, role, department, is_active, created_at, college_uid
             FROM users
             WHERE role = ?1 AND is_active = 1
             ORDER BY id ASC",
        )?;
        let mapped = stmt.query_map(params![role], |r| {
            Ok((
                UserSummary {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    full_name: r.get(2)?,
                    role: r.get(3)?,
                    department: r.get(4)?,
                    is_active: r.get::<_, i64>(5)? == 1,
                    created_at: r.get(6)?,
                },
                r.get::<_, Option<String>>(7)?,
            ))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    } else if let Some(allowed) = allowed_roles {
        let placeholders = vec!["?"; allowed.len()].join(", ");
        let query = format!(
            "SELECT id, username, full_name, role, department, is_active, created_at, college_uid
             FROM users
             WHERE role IN ({}) AND is_active = 1
             ORDER BY id ASC",
            placeholders
        );
        let mut stmt = conn.prepare(&query)?;
        let mapped = stmt.query_map(
            rusqlite::params_from_iter(allowed.iter().copied()),
            |r| {
                Ok((
                    UserSummary {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        full_name: r.get(2)?,
                        role: r.get(3)?,
                        department: r.get(4)?,
                        is_active: r.get::<_, i64>(5)? == 1,
                        created_at: r.get(6)?,
                    },
                    r.get::<_, Option<String>>(7)?,
                ))
            },
        )?;
        mapped.collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = conn.prepare(
              "SELECT id, username, full_name, role, department, is_active, created_at, college_uid
             FROM users
             WHERE is_active = 1
             ORDER BY id ASC",
        )?;
        let mapped = stmt.query_map([], |r| {
            Ok((
                UserSummary {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    full_name: r.get(2)?,
                    role: r.get(3)?,
                    department: r.get(4)?,
                    is_active: r.get::<_, i64>(5)? == 1,
                    created_at: r.get(6)?,
                },
                r.get::<_, Option<String>>(7)?,
            ))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    let mut filtered = rows_with_scope;

    if actor_role != "platform_admin" {
        filtered.retain(|(u, _)| u.role != "platform_admin");
    }

    if actor_role != "platform_admin" {
        let actor_uid = actor_college_uid.ok_or_else(|| {
            AppError::Validation("actor is not assigned to any college".to_string())
        })?;
        filtered.retain(|(_, user_college_uid)| user_college_uid.as_deref() == Some(actor_uid.as_str()));
    }

    if actor_role == "department_admin" {
        let normalized_actor_department = get_actor_department(&conn, &actor_username)?;

        filtered.retain(|(u, _)| {
            if u.role != "lecturer" && u.role != "student" {
                return false;
            }

            let user_department = u.department.as_deref().map(normalize_upper).unwrap_or_default();
            !user_department.is_empty() && user_department == normalized_actor_department
        });
    }

    Ok(filtered.into_iter().map(|(u, _)| u).collect())
}

#[tauri::command]
fn create_course(
    app: tauri::AppHandle,
    actor_username: String,
    code: String,
    title: String,
    department: Option<String>,
    semester: i64,
) -> Result<CourseSummary, AppError> {
    if semester <= 0 {
        return Err(AppError::Validation("semester must be positive".to_string()));
    }

    let conn = open_connection(&app)?;
    let (actor_id, actor_role) = get_actor(&conn, &actor_username)?;
    if actor_role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    conn.execute(
        "INSERT INTO courses (code, title, lecturer_user_id, department, semester, status, sync_state) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'local_new')",
        params![normalize_upper(&code), title.trim(), actor_id, department, semester],
    )?;
    let course_id = conn.last_insert_rowid();
    log_outbox(&conn, "courses", course_id, "insert")?;

    let course = conn.query_row(
        "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
         FROM courses c
         JOIN users u ON u.id = c.lecturer_user_id
         WHERE c.id = ?1",
        params![course_id],
        |r| {
            Ok(CourseSummary {
                id: r.get(0)?,
                code: r.get(1)?,
                title: r.get(2)?,
                department: r.get(3)?,
                semester: r.get(4)?,
                status: r.get(5)?,
                lecturer_username: r.get(6)?,
            })
        },
    )?;
    Ok(course)
}

#[tauri::command]
fn list_courses(
    app: tauri::AppHandle,
    actor_username: String,
    include_ended: bool,
) -> Result<Vec<CourseSummary>, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, actor_role) = get_actor(&conn, &actor_username)?;

    let (sql, needs_actor_param) = if actor_role == "lecturer" {
        if include_ended {
            (
                "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
             FROM courses c
             JOIN users u ON u.id = c.lecturer_user_id
             WHERE c.lecturer_user_id = ?1
             ORDER BY c.id DESC",
                true,
            )
        } else {
            (
                "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
             FROM courses c
             JOIN users u ON u.id = c.lecturer_user_id
             WHERE c.lecturer_user_id = ?1 AND c.status != 'ended'
             ORDER BY c.id DESC",
                true,
            )
        }
    } else if actor_role == "student" {
        if include_ended {
            (
                "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
             FROM course_members cm
             JOIN courses c ON c.id = cm.course_id
             JOIN users u ON u.id = c.lecturer_user_id
             WHERE cm.student_user_id = ?1 AND cm.removed_at IS NULL
             ORDER BY c.id DESC",
                true,
            )
        } else {
            (
                "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
             FROM course_members cm
             JOIN courses c ON c.id = cm.course_id
             JOIN users u ON u.id = c.lecturer_user_id
             WHERE cm.student_user_id = ?1 AND cm.removed_at IS NULL AND c.status != 'ended'
             ORDER BY c.id DESC",
                true,
            )
        }
    } else {
        if include_ended {
            (
                "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
             FROM courses c
             JOIN users u ON u.id = c.lecturer_user_id
             ORDER BY c.id DESC",
                false,
            )
        } else {
            (
                "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
             FROM courses c
             JOIN users u ON u.id = c.lecturer_user_id
             WHERE c.status != 'ended'
             ORDER BY c.id DESC",
                false,
            )
        }
    };

    let mut stmt = conn.prepare(sql)?;
    let items = if needs_actor_param {
        stmt.query_map(params![actor_id], |r| {
            Ok(CourseSummary {
                id: r.get(0)?,
                code: r.get(1)?,
                title: r.get(2)?,
                department: r.get(3)?,
                semester: r.get(4)?,
                status: r.get(5)?,
                lecturer_username: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], |r| {
            Ok(CourseSummary {
                id: r.get(0)?,
                code: r.get(1)?,
                title: r.get(2)?,
                department: r.get(3)?,
                semester: r.get(4)?,
                status: r.get(5)?,
                lecturer_username: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };

    Ok(items)
}

#[tauri::command]
fn list_course_catalog(app: tauri::AppHandle, actor_username: String) -> Result<Vec<CourseSummary>, AppError> {
    let conn = open_connection(&app)?;
    let (_, role) = get_actor(&conn, &actor_username)?;
    if role != "student" {
        return Err(AppError::AccessDenied);
    }

    let mut stmt = conn.prepare(
        "SELECT c.id, c.code, c.title, c.department, c.semester, c.status, u.username
         FROM courses c
         JOIN users u ON u.id = c.lecturer_user_id
         WHERE c.status = 'active'
         ORDER BY c.id DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CourseSummary {
                id: r.get(0)?,
                code: r.get(1)?,
                title: r.get(2)?,
                department: r.get(3)?,
                semester: r.get(4)?,
                status: r.get(5)?,
                lecturer_username: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}

#[tauri::command]
fn request_course_join(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "student" {
        return Err(AppError::AccessDenied);
    }

    conn.execute(
        "INSERT OR REPLACE INTO enrollment_requests (course_id, student_user_id, status, updated_at, sync_state)
         VALUES (?1, ?2, 'pending', datetime('now'), 'local_new')",
        params![course_id, actor_id],
    )?;
    let req_id = conn.last_insert_rowid();
    log_outbox(&conn, "enrollment_requests", req_id, "insert")?;
    Ok(true)
}

#[tauri::command]
fn list_pending_enrollment_requests(
    app: tauri::AppHandle,
    actor_username: String,
) -> Result<Vec<EnrollmentRequestSummary>, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    let mut stmt = conn.prepare(
        "SELECT er.id, c.id, c.code, su.username, er.status, er.created_at
         FROM enrollment_requests er
         JOIN courses c ON c.id = er.course_id
         JOIN users su ON su.id = er.student_user_id
         WHERE c.lecturer_user_id = ?1 AND er.status = 'pending'
         ORDER BY er.id DESC",
    )?;

    let rows = stmt
        .query_map(params![actor_id], |r| {
            Ok(EnrollmentRequestSummary {
                id: r.get(0)?,
                course_id: r.get(1)?,
                course_code: r.get(2)?,
                student_username: r.get(3)?,
                status: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}

#[tauri::command]
fn handle_enrollment_request(
    app: tauri::AppHandle,
    actor_username: String,
    request_id: i64,
    approve: bool,
) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    let payload = conn
        .query_row(
            "SELECT er.course_id, er.student_user_id
             FROM enrollment_requests er
             JOIN courses c ON c.id = er.course_id
             WHERE er.id = ?1 AND c.lecturer_user_id = ?2",
            params![request_id, actor_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or(AppError::TargetNotFound)?;

    let (course_id, student_user_id) = payload;
    conn.execute(
        "UPDATE enrollment_requests SET status = ?1, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?2",
        params![if approve { "approved" } else { "rejected" }, request_id],
    )?;
    log_outbox(&conn, "enrollment_requests", request_id, "update")?;

    if approve {
        conn.execute(
            "INSERT OR IGNORE INTO course_members (course_id, student_user_id, version, sync_state) VALUES (?1, ?2, 1, 'local_new')",
            params![course_id, student_user_id],
        )?;
        let member_id = conn.last_insert_rowid();
        if member_id > 0 {
            log_outbox(&conn, "course_members", member_id, "insert")?;
        }
    }

    Ok(true)
}

#[tauri::command]
fn end_course(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
    confirmation: bool,
) -> Result<bool, AppError> {
    if !confirmation {
        return Err(AppError::Validation(
            "double confirmation required to end course".to_string(),
        ));
    }

    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    let owner_ok: Option<i64> = conn
        .query_row(
            "SELECT id FROM courses WHERE id = ?1 AND lecturer_user_id = ?2",
            params![course_id, actor_id],
            |r| r.get(0),
        )
        .optional()?;
    if owner_ok.is_none() {
        return Err(AppError::AccessDenied);
    }

    conn.execute(
        "UPDATE courses SET status = 'ended', end_announced_at = datetime('now'), updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE id = ?1",
        params![course_id],
    )?;
    log_outbox(&conn, "courses", course_id, "update")?;

    let deadline = (Utc::now() + Duration::days(15)).format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "UPDATE course_members SET removal_deadline_at = ?1, version = version + 1, sync_state = 'local_updated' WHERE course_id = ?2 AND removed_at IS NULL",
        params![deadline, course_id],
    )?;

    Ok(true)
}

#[tauri::command]
fn acknowledge_ended_course(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "student" {
        return Err(AppError::AccessDenied);
    }

    conn.execute(
        "UPDATE course_members SET removed_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE course_id = ?1 AND student_user_id = ?2 AND removed_at IS NULL",
        params![course_id, actor_id],
    )?;
    Ok(true)
}

#[tauri::command]
fn cleanup_expired_ended_courses(app: tauri::AppHandle) -> Result<i64, AppError> {
    let conn = open_connection(&app)?;
    let changed = conn.execute(
        "UPDATE course_members SET removed_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE removed_at IS NULL AND removal_deadline_at IS NOT NULL AND removal_deadline_at <= datetime('now')",
        [],
    )?;
    Ok(changed as i64)
}

#[tauri::command]
fn mark_attendance_bulk(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
    entries: Vec<AttendanceEntryInput>,
) -> Result<i64, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    let owner_ok: Option<i64> = conn
        .query_row(
            "SELECT id FROM courses WHERE id = ?1 AND lecturer_user_id = ?2",
            params![course_id, actor_id],
            |r| r.get(0),
        )
        .optional()?;
    if owner_ok.is_none() {
        return Err(AppError::AccessDenied);
    }

    let mut count = 0_i64;
    for e in entries {
        let status = e.status.trim().to_uppercase();
        if status != "P" && status != "A" {
            continue;
        }

        let student = get_user_by_username(&conn, &normalize_upper(&e.student_username))?;
        if student.role != "student" {
            continue;
        }

        conn.execute(
            "INSERT INTO attendance_records (course_id, student_user_id, attendance_date, status, marked_by, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, 'local_new')
             ON CONFLICT(course_id, student_user_id, attendance_date)
             DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, version = attendance_records.version + 1, sync_state = 'local_updated'",
            params![course_id, student.id, e.attendance_date.trim(), status, actor_id],
        )?;
        let attendance_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM attendance_records WHERE course_id = ?1 AND student_user_id = ?2 AND attendance_date = ?3",
                params![course_id, student.id, e.attendance_date.trim()],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(aid) = attendance_id {
            log_outbox(&conn, "attendance_records", aid, "update")?;
        }
        count += 1;
    }

    Ok(count)
}

#[tauri::command]
fn upsert_internal_marks(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
    student_username: String,
    internal_marks: i64,
) -> Result<bool, AppError> {
    if !(0..=50).contains(&internal_marks) {
        return Err(AppError::Validation("internal marks must be in 0..50".to_string()));
    }

    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    let owner_ok: Option<i64> = conn
        .query_row(
            "SELECT id FROM courses WHERE id = ?1 AND lecturer_user_id = ?2",
            params![course_id, actor_id],
            |r| r.get(0),
        )
        .optional()?;
    if owner_ok.is_none() {
        return Err(AppError::AccessDenied);
    }

    let student = get_user_by_username(&conn, &normalize_upper(&student_username))?;
    conn.execute(
        "INSERT INTO marks (course_id, student_user_id, internal_marks, updated_by, sync_state)
         VALUES (?1, ?2, ?3, ?4, 'local_new')
         ON CONFLICT(course_id, student_user_id)
         DO UPDATE SET internal_marks = excluded.internal_marks, updated_by = excluded.updated_by, updated_at = datetime('now'), version = marks.version + 1, sync_state = 'local_updated'",
        params![course_id, student.id, internal_marks, actor_id],
    )?;
    let marks_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM marks WHERE course_id = ?1 AND student_user_id = ?2",
            params![course_id, student.id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(mid) = marks_id {
        log_outbox(&conn, "marks", mid, "update")?;
    }
    Ok(true)
}

#[tauri::command]
fn submit_external_marks(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
    external_marks: i64,
) -> Result<bool, AppError> {
    if !(0..=50).contains(&external_marks) {
        return Err(AppError::Validation("external marks must be in 0..50".to_string()));
    }

    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "student" {
        return Err(AppError::AccessDenied);
    }

    conn.execute(
        "INSERT INTO marks (course_id, student_user_id, external_marks, updated_by, sync_state)
         VALUES (?1, ?2, ?3, ?2, 'local_new')
         ON CONFLICT(course_id, student_user_id)
         DO UPDATE SET external_marks = excluded.external_marks, updated_at = datetime('now'), version = marks.version + 1, sync_state = 'local_updated'",
        params![course_id, actor_id, external_marks],
    )?;
    let marks_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM marks WHERE course_id = ?1 AND student_user_id = ?2",
            params![course_id, actor_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(mid) = marks_id {
        log_outbox(&conn, "marks", mid, "update")?;
    }
    Ok(true)
}

#[tauri::command]
fn decide_student_result(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
    student_username: String,
    decision: String,
) -> Result<bool, AppError> {
    let final_decision = decision.trim().to_lowercase();
    if final_decision != "pass" && final_decision != "fail" && final_decision != "override_pass" {
        return Err(AppError::Validation(
            "decision must be pass, fail or override_pass".to_string(),
        ));
    }

    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    let owner_ok: Option<i64> = conn
        .query_row(
            "SELECT id FROM courses WHERE id = ?1 AND lecturer_user_id = ?2",
            params![course_id, actor_id],
            |r| r.get(0),
        )
        .optional()?;
    if owner_ok.is_none() {
        return Err(AppError::AccessDenied);
    }

    let student = get_user_by_username(&conn, &normalize_upper(&student_username))?;
    conn.execute(
        "INSERT INTO marks (course_id, student_user_id, lecturer_decision, updated_by, sync_state)
         VALUES (?1, ?2, ?3, ?4, 'local_new')
         ON CONFLICT(course_id, student_user_id)
         DO UPDATE SET lecturer_decision = excluded.lecturer_decision, updated_by = excluded.updated_by, updated_at = datetime('now'), version = marks.version + 1, sync_state = 'local_updated'",
        params![course_id, student.id, final_decision, actor_id],
    )?;
    let marks_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM marks WHERE course_id = ?1 AND student_user_id = ?2",
            params![course_id, student.id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(mid) = marks_id {
        log_outbox(&conn, "marks", mid, "update")?;
    }
    Ok(true)
}

#[tauri::command]
fn append_course_progress(
    app: tauri::AppHandle,
    actor_username: String,
    course_id: i64,
    progress_text: String,
) -> Result<bool, AppError> {
    let trimmed = progress_text.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Validation("progress text is empty".to_string()));
    }

    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "lecturer" {
        return Err(AppError::AccessDenied);
    }

    conn.execute(
        "INSERT INTO course_progress_log (course_id, lecturer_user_id, progress_text, sync_state)
         VALUES (?1, ?2, ?3, 'local_new')",
        params![course_id, actor_id, trimmed],
    )?;
    let pid = conn.last_insert_rowid();
    log_outbox(&conn, "course_progress_log", pid, "insert")?;
    Ok(true)
}

#[tauri::command]
fn promote_or_reset_student_semester(
    app: tauri::AppHandle,
    actor_username: String,
    student_username: String,
    force_promote: bool,
) -> Result<bool, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role) = get_actor(&conn, &actor_username)?;
    if actor_role != "lecturer" && actor_role != "department_admin" {
        return Err(AppError::AccessDenied);
    }

    let student = get_user_by_username(&conn, &normalize_upper(&student_username))?;
    if student.role != "student" {
        return Err(AppError::Validation("target user is not a student".to_string()));
    }

    ensure_student_semester_row(&conn, student.id)?;
    let current_sem: i64 = conn.query_row(
        "SELECT current_semester FROM student_semesters WHERE student_user_id = ?1",
        params![student.id],
        |r| r.get(0),
    )?;

    let mut pass_count = 0_i64;
    let mut fail_count = 0_i64;

    let mut stmt = conn.prepare(
        "SELECT m.internal_marks, m.external_marks, m.lecturer_decision
         FROM marks m
         JOIN courses c ON c.id = m.course_id
         WHERE m.student_user_id = ?1 AND c.semester = ?2",
    )?;

    let rows = stmt.query_map(params![student.id, current_sem], |r| {
        Ok((
            r.get::<_, Option<i64>>(0)?,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;

    for row in rows {
        let (internal, external, decision) = row?;
        let decision = decision.unwrap_or_else(|| "".to_string());
        let is_pass = decision == "override_pass"
            || decision == "pass"
            || (internal.unwrap_or(0) >= 20 && external.unwrap_or(0) >= 20 && decision != "fail");
        if is_pass {
            pass_count += 1;
        } else {
            fail_count += 1;
        }
    }

    if force_promote || (pass_count > 0 && fail_count == 0) {
        conn.execute(
            "UPDATE student_semesters SET current_semester = current_semester + 1, updated_at = datetime('now'), version = version + 1, sync_state = 'local_updated' WHERE student_user_id = ?1",
            params![student.id],
        )?;
        log_outbox(&conn, "student_semesters", student.id, "update")?;
        return Ok(true);
    }

    conn.execute(
        "DELETE FROM attendance_records WHERE student_user_id = ?1 AND course_id IN (SELECT id FROM courses WHERE semester = ?2)",
        params![student.id, current_sem],
    )?;
    conn.execute(
        "DELETE FROM marks WHERE student_user_id = ?1 AND course_id IN (SELECT id FROM courses WHERE semester = ?2)",
        params![student.id, current_sem],
    )?;

    Ok(false)
}

#[tauri::command]
fn get_student_dashboard(
    app: tauri::AppHandle,
    actor_username: String,
) -> Result<StudentDashboard, AppError> {
    let conn = open_connection(&app)?;
    let (actor_id, role) = get_actor(&conn, &actor_username)?;
    if role != "student" {
        return Err(AppError::AccessDenied);
    }

    ensure_student_semester_row(&conn, actor_id)?;
    let current_semester: i64 = conn.query_row(
        "SELECT current_semester FROM student_semesters WHERE student_user_id = ?1",
        params![actor_id],
        |r| r.get(0),
    )?;

    let mut stmt = conn.prepare(
        "SELECT
            c.id,
            c.code,
            c.title,
            c.semester,
            c.status,
            m.internal_marks,
            m.external_marks,
            m.lecturer_decision,
            COALESCE((
                SELECT ROUND(100.0 * SUM(CASE WHEN ar.status = 'P' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2)
                FROM attendance_records ar
                WHERE ar.course_id = c.id AND ar.student_user_id = ?1
            ), 0.0)
         FROM course_members cm
         JOIN courses c ON c.id = cm.course_id
         LEFT JOIN marks m ON m.course_id = c.id AND m.student_user_id = cm.student_user_id
         WHERE cm.student_user_id = ?1 AND cm.removed_at IS NULL
         ORDER BY c.id DESC",
    )?;

    let courses = stmt
        .query_map(params![actor_id], |r| {
            Ok(StudentDashboardCourse {
                course_id: r.get(0)?,
                course_code: r.get(1)?,
                course_title: r.get(2)?,
                semester: r.get(3)?,
                status: r.get(4)?,
                internal_marks: r.get(5)?,
                external_marks: r.get(6)?,
                lecturer_decision: r.get(7)?,
                attendance_percent: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(StudentDashboard {
        username: actor_username,
        current_semester,
        courses,
    })
}

#[tauri::command]
fn export_course_data(
    app: tauri::AppHandle,
    actor_username: String,
    department: Option<String>,
    semester: Option<i64>,
    course_id: Option<i64>,
    format: String,
    output_path: String,
) -> Result<String, AppError> {
    let conn = open_connection(&app)?;
    let (_, role) = get_actor(&conn, &actor_username)?;
    if !matches!(role.as_str(), "lecturer" | "department_admin" | "super_admin" | "platform_admin") {
        return Err(AppError::AccessDenied);
    }

    let mut sql = String::from(
        "SELECT
            c.code,
            c.title,
            c.department,
            c.semester,
            su.username,
            COALESCE((
                SELECT ROUND(100.0 * SUM(CASE WHEN ar.status = 'P' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2)
                FROM attendance_records ar
                WHERE ar.course_id = c.id AND ar.student_user_id = su.id
            ), 0.0) as attendance_percent,
            m.internal_marks,
            m.external_marks,
            m.lecturer_decision
         FROM marks m
         JOIN courses c ON c.id = m.course_id
         JOIN users su ON su.id = m.student_user_id
         WHERE 1=1",
    );

    if let Some(cid) = course_id {
        sql.push_str(&format!(" AND c.id = {}", cid));
    }
    if let Some(sem) = semester {
        sql.push_str(&format!(" AND c.semester = {}", sem));
    }
    if let Some(dep) = department {
        sql.push_str(&format!(" AND c.department = '{}'", dep.replace('\'', "''")));
    }
    sql.push_str(" ORDER BY c.id DESC, su.username ASC");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, f64>(5)?,
                r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                r.get::<_, Option<String>>(8)?.unwrap_or_default(),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let path = PathBuf::from(output_path);
    let fmt = format.to_lowercase();
    if fmt == "csv" {
        let mut writer = csv::Writer::from_path(&path)
            .map_err(|e| AppError::Export(format!("csv open error: {e}")))?;
        writer
            .write_record([
                "course_code",
                "course_title",
                "department",
                "semester",
                "student_username",
                "attendance_percent",
                "internal_marks",
                "external_marks",
                "lecturer_decision",
            ])
            .map_err(|e| AppError::Export(format!("csv header error: {e}")))?;

        for row in rows {
            writer
                .write_record([
                    row.0,
                    row.1,
                    row.2,
                    row.3.to_string(),
                    row.4,
                    row.5.to_string(),
                    row.6.to_string(),
                    row.7.to_string(),
                    row.8,
                ])
                .map_err(|e| AppError::Export(format!("csv row error: {e}")))?;
        }
        writer
            .flush()
            .map_err(|e| AppError::Export(format!("csv flush error: {e}")))?;
    } else if fmt == "excel" {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();

        let headers = [
            "course_code",
            "course_title",
            "department",
            "semester",
            "student_username",
            "attendance_percent",
            "internal_marks",
            "external_marks",
            "lecturer_decision",
        ];
        for (col, header) in headers.iter().enumerate() {
            worksheet
                .write_string(0, col as u16, *header)
                .map_err(|e| AppError::Export(format!("xlsx header error: {e}")))?;
        }

        for (idx, row) in rows.iter().enumerate() {
            let r = (idx + 1) as u32;
            worksheet
                .write_string(r, 0, &row.0)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_string(r, 1, &row.1)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_string(r, 2, &row.2)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_number(r, 3, row.3 as f64)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_string(r, 4, &row.4)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_number(r, 5, row.5)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_number(r, 6, row.6 as f64)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_number(r, 7, row.7 as f64)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
            worksheet
                .write_string(r, 8, &row.8)
                .map_err(|e| AppError::Export(format!("xlsx write error: {e}")))?;
        }

        workbook
            .save(path)
            .map_err(|e| AppError::Export(format!("xlsx save error: {e}")))?;
    } else {
        return Err(AppError::Validation(
            "format must be csv or excel".to_string(),
        ));
    }

    Ok("export completed".to_string())
}

#[tauri::command]
fn get_sync_stats(app: tauri::AppHandle) -> Result<(i64, i64, i64), AppError> {
    let conn = open_connection(&app)?;
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )?;
    let sent: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE status = 'sent'",
        [],
        |r| r.get(0),
    )?;
    let failed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE status = 'failed'",
        [],
        |r| r.get(0),
    )?;
    Ok((pending, sent, failed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db open");
        apply_migration(&conn).expect("migration apply");
        conn
    }

    fn seed_user(conn: &Connection, id: i64, username: &str, role: &str) {
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, department, is_active, sync_state)
             VALUES (?1, ?2, ?3, ?4, NULL, 1, 'synced')",
            params![id, username, "$argon2id$v=19$m=19456,t=2,p=1$bnVsbA$bnVsbA", role],
        )
        .expect("seed user");
    }

    fn seed_course(conn: &Connection, id: i64, lecturer_user_id: i64) {
        conn.execute(
            "INSERT INTO courses (id, code, title, lecturer_user_id, department, semester, status, sync_state)
             VALUES (?1, 'CSE101', 'Algorithms', ?2, 'CSE', 1, 'active', 'synced')",
            params![id, lecturer_user_id],
        )
        .expect("seed course");
    }

    #[test]
    fn role_matrix_is_correct() {
        assert!(role_can_create("platform_admin", "super_admin"));
        assert!(role_can_create("super_admin", "department_admin"));
        assert!(role_can_create("department_admin", "lecturer"));
        assert!(role_can_create("department_admin", "student"));
        assert!(!role_can_create("lecturer", "student"));
    }

    #[test]
    fn sync_state_for_delete_is_deleted() {
        assert_eq!(sync_state_for_operation("delete"), "deleted");
        assert_eq!(sync_state_for_operation("update"), "server_new");
    }

    #[test]
    fn outbox_collect_and_mark_sent() {
        let conn = setup_conn();
        conn.execute(
            "INSERT INTO sync_outbox (table_name, record_id, operation, payload, status) VALUES ('users', 1, 'insert', '{\"id\":1}', 'pending')",
            [],
        )
        .expect("insert outbox");

        let records = collect_pending_outbox(&conn, 10).expect("collect pending");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].table_name, "users");

        mark_outbox_sent(&conn, &[records[0].outbox_id]).expect("mark sent");
        let sent_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE status = 'sent'", [], |r| r.get(0))
            .expect("count sent");
        assert_eq!(sent_count, 1);
    }

    #[test]
    fn outbox_rejected_transitions_to_failed_after_retries() {
        let conn = setup_conn();
        conn.execute(
            "INSERT INTO sync_outbox (table_name, record_id, operation, payload, status, retries) VALUES ('users', 1, 'insert', '{\"id\":1}', 'pending', 2)",
            [],
        )
        .expect("insert outbox");

        let id: i64 = conn
            .query_row("SELECT id FROM sync_outbox LIMIT 1", [], |r| r.get(0))
            .expect("fetch outbox id");

        mark_outbox_failed(
            &conn,
            &[SyncRejectedItem {
                outbox_id: id,
                reason: "version conflict".to_string(),
            }],
        )
        .expect("mark failed");

        let row = conn
            .query_row(
                "SELECT retries, status FROM sync_outbox WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .expect("fetch failed row");

        assert_eq!(row.0, 3);
        assert_eq!(row.1, "failed");
    }

    #[test]
    fn pull_change_upserts_user_and_course() {
        let conn = setup_conn();
        let user_change = SyncPullChange {
            table_name: "users".to_string(),
            operation: "update".to_string(),
            record: json!({
                "id": 10,
                "username": "4SE22CS001",
                "password_hash": "$argon2id$v=19$m=19456,t=2,p=1$bnVsbA$bnVsbA",
                "role": "student",
                "department": "CSE",
                "is_active": true
            }),
        };
        apply_pull_change(&conn, &user_change).expect("apply user change");

        seed_user(&conn, 20, "LECT001", "lecturer");
        let course_change = SyncPullChange {
            table_name: "courses".to_string(),
            operation: "insert".to_string(),
            record: json!({
                "id": 30,
                "code": "CSE401",
                "title": "Compiler Design",
                "lecturer_user_id": 20,
                "department": "CSE",
                "semester": 4,
                "status": "active"
            }),
        };
        apply_pull_change(&conn, &course_change).expect("apply course change");

        let user_exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM users WHERE id = 10", [], |r| r.get(0))
            .expect("count user");
        let course_exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM courses WHERE id = 30", [], |r| r.get(0))
            .expect("count course");
        assert_eq!(user_exists, 1);
        assert_eq!(course_exists, 1);
    }

    #[test]
    fn pull_change_deletes_marks_row() {
        let conn = setup_conn();
        seed_user(&conn, 1, "LECT001", "lecturer");
        seed_user(&conn, 2, "4SE22CS001", "student");
        seed_course(&conn, 3, 1);

        conn.execute(
            "INSERT INTO marks (id, course_id, student_user_id, internal_marks, external_marks, lecturer_decision, updated_by, sync_state)
             VALUES (90, 3, 2, 45, 40, 'pass', 1, 'synced')",
            [],
        )
        .expect("seed marks");

        let change = SyncPullChange {
            table_name: "marks".to_string(),
            operation: "delete".to_string(),
            record: json!({ "id": 90 }),
        };
        apply_pull_change(&conn, &change).expect("delete mark");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM marks WHERE id = 90", [], |r| r.get(0))
            .expect("count marks");
        assert_eq!(count, 0);
    }
}

// Student data fetching commands
#[tauri::command]
fn get_student_by_user_id(
    app: tauri::AppHandle,
    actor_username: String,
    user_id: i64,
) -> Result<student_repository::StudentWithRelationships, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only allow actors to view their own student data or if they're admin
    if actor_role == "student" {
        let actor_id: i64 = conn
            .query_row("SELECT id FROM users WHERE username = ?1", params![&actor_username], |r| r.get(0))
            .optional()?
            .ok_or(AppError::TargetNotFound)?;
        if actor_id != user_id {
            return Err(AppError::AccessDenied);
        }
    } else if actor_role != "department_admin" && actor_role != "super_admin" && actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    student_repository::get_student_by_user_id(&conn, user_id)
}

#[tauri::command]
fn get_students_by_department(
    app: tauri::AppHandle,
    actor_username: String,
    department: String,
    enrollment_status: Option<String>,
) -> Result<Vec<student_repository::StudentRow>, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only department_admin, super_admin, and platform_admin can list students
    if actor_role == "department_admin" {
        let actor_department = get_actor_department(&conn, &actor_username)?;
        if department != actor_department {
            return Err(AppError::AccessDenied);
        }
    } else if actor_role != "super_admin" && actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    student_repository::get_students_by_department(
        &conn,
        &department,
        enrollment_status.as_deref(),
    )
}

#[tauri::command]
fn get_students_by_admin(
    app: tauri::AppHandle,
    actor_username: String,
    admin_user_id: i64,
) -> Result<Vec<student_repository::StudentRow>, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only allow viewing own students or if super_admin/platform_admin
    if actor_role == "department_admin" {
        let actor_id: i64 = conn
            .query_row("SELECT id FROM users WHERE username = ?1", params![&actor_username], |r| r.get(0))
            .optional()?
            .ok_or(AppError::TargetNotFound)?;
        if actor_id != admin_user_id {
            return Err(AppError::AccessDenied);
        }
    } else if actor_role != "super_admin" && actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    student_repository::get_students_by_admin(&conn, admin_user_id)
}

#[tauri::command]
fn get_students_by_lecturer(
    app: tauri::AppHandle,
    actor_username: String,
    lecturer_user_id: i64,
) -> Result<Vec<student_repository::StudentRow>, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only lecturer, admin, and platform_admin can list students by lecturer
    if actor_role == "lecturer" {
        let actor_id: i64 = conn
            .query_row("SELECT id FROM users WHERE username = ?1", params![&actor_username], |r| r.get(0))
            .optional()?
            .ok_or(AppError::TargetNotFound)?;
        if actor_id != lecturer_user_id {
            return Err(AppError::AccessDenied);
        }
    } else if actor_role != "department_admin" && actor_role != "super_admin" && actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    student_repository::get_students_by_lecturer(&conn, lecturer_user_id)
}

#[tauri::command]
fn update_student_enrollment_status(
    app: tauri::AppHandle,
    actor_username: String,
    student_id: i64,
    enrollment_status: String,
) -> Result<(), AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only admin and platform_admin can update status
    if actor_role != "department_admin" && actor_role != "super_admin" && actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    // Validate enrollment_status
    if !["active", "inactive", "graduated", "suspended"].contains(&enrollment_status.as_str()) {
        return Err(AppError::Validation("invalid enrollment status".to_string()));
    }

    student_repository::update_student_enrollment_status(&conn, student_id, &enrollment_status)
}

#[tauri::command]
fn update_student_semester(
    app: tauri::AppHandle,
    actor_username: String,
    student_id: i64,
    semester: i32,
) -> Result<(), AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only admin and platform_admin can update semester
    if actor_role != "department_admin" && actor_role != "super_admin" && actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    if semester <= 0 {
        return Err(AppError::Validation("semester must be positive".to_string()));
    }

    student_repository::update_student_semester(&conn, student_id, semester)
}

#[tauri::command]
fn add_student_lecturer_relationship(
    app: tauri::AppHandle,
    actor_username: String,
    student_id: i64,
    lecturer_id: i64,
    relationship_type: String,
) -> Result<i64, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only admin can create relationships
    if actor_role != "department_admin" && actor_role != "super_admin" && actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    if !["enrolled", "assigned", "supervised"].contains(&relationship_type.as_str()) {
        return Err(AppError::Validation("invalid relationship type".to_string()));
    }

    student_repository::create_student_lecturer_relationship(&conn, student_id, lecturer_id, &relationship_type)
}

#[tauri::command]
fn clear_all_local_students(
    app: tauri::AppHandle,
    actor_username: String,
) -> Result<i64, AppError> {
    let conn = open_connection(&app)?;
    let (_, actor_role, _, _, _) = get_actor_scope(&conn, &actor_username)?;

    // Only platform_admin can clear all students
    if actor_role != "platform_admin" {
        return Err(AppError::AccessDenied);
    }

    // Delete all student-related records
    conn.execute("DELETE FROM student_lecturer_relationships", [])?;
    conn.execute("DELETE FROM student_admin_relationships", [])?;
    let deleted = conn.execute("DELETE FROM students", [])?;

    // Note: User records with role='student' remain for data integrity
    Ok(deleted as i64)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            initialize_system,
            seed_full_sync_snapshot,
            seed_platform_admin,
            login,
            login_student,
            login_admin,
            login_lecturer,
            login_platform_admin,
            is_internal_password_setup_required,
            set_internal_password,
            prune_local_data_for_actor,
            create_lecturer_with_unique_number,
            bulk_create_students_by_range,
            start_bulk_create_lecturers_job,
            start_bulk_create_students_from_usns_job,
            start_bulk_create_students_by_range_job,
            get_bulk_job_status,
            get_department_admin_bulk_defaults,
            update_my_profile_name,
            create_user,
            create_department_admin_with_unique_number,
            update_user,
            delete_user,
            bulk_create_lecturers,
            bulk_create_students_from_usns,
            list_users,
            get_student_by_user_id,
            get_students_by_department,
            get_students_by_admin,
            get_students_by_lecturer,
            update_student_enrollment_status,
            update_student_semester,
            add_student_lecturer_relationship,
            clear_all_local_students,
            create_course,
            list_courses,
            list_course_catalog,
            request_course_join,
            list_pending_enrollment_requests,
            handle_enrollment_request,
            end_course,
            acknowledge_ended_course,
            cleanup_expired_ended_courses,
            mark_attendance_bulk,
            upsert_internal_marks,
            submit_external_marks,
            decide_student_result,
            append_course_progress,
            promote_or_reset_student_semester,
            get_student_dashboard,
            export_course_data,
            get_sync_stats,
            process_outbox_and_sync
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
