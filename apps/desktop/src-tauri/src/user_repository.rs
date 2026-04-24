use super::{apply_migration, ensure_student_semester_row, hash_password, normalize_upper, AppError, UserSummary};
use chrono::Utc;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
struct SyncPushResponse {
    accepted_outbox_ids: Vec<i64>,
    rejected: Option<Vec<SyncRejectedItem>>,
}

#[derive(Debug, Deserialize)]
struct SyncRejectedItem {
    outbox_id: i64,
    reason: String,
}

fn next_user_id(conn: &Connection) -> Result<i64, AppError> {
    let next_id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM users", [], |r| r.get(0))?;
    Ok(next_id)
}

fn insert_local_user(
    conn: &Connection,
    user_id: i64,
    username: &str,
    password_hash: &str,
    role: &str,
    department: Option<&str>,
    college_uid: Option<&str>,
    college_name: Option<&str>,
    college_identification_number: Option<&str>,
    full_name: Option<&str>,
    sync_state: &str,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO users (id, username, password_hash, role, department, college_uid, college_name, college_identification_number, full_name, internal_password_hash, internal_password_required, sync_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 1, ?10)",
        params![
            user_id,
            username,
            password_hash,
            role,
            department,
            college_uid,
            college_name,
            college_identification_number,
            full_name,
            sync_state
        ],
    )?;
    if role == "student" {
        ensure_student_semester_row(conn, user_id)?;
    }
    Ok(())
}

pub fn save_new_user(
    conn: &Connection,
    username: &str,
    raw_password: &str,
    role: &str,
    department: Option<&str>,
    college_uid: Option<&str>,
    college_name: Option<&str>,
    college_identification_number: Option<&str>,
    full_name: Option<&str>,
) -> Result<UserSummary, AppError> {
    apply_migration(conn)?;

    let canonical_username = normalize_upper(username);
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM users WHERE username = ?1",
            params![canonical_username],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Err(AppError::UserAlreadyExists);
    }

    let password_hash = hash_password(raw_password)?;
    let created_id = next_user_id(conn)?;
    insert_local_user(
        conn,
        created_id,
        &canonical_username,
        &password_hash,
        role,
        department,
        college_uid,
        college_name,
        college_identification_number,
        full_name,
        "local_new",
    )?;

    let created = conn.query_row(
        "SELECT id, username, full_name, role, department, is_active, created_at FROM users WHERE id = ?1",
        params![created_id],
        |r| {
            Ok(UserSummary {
                id: r.get(0)?,
                username: r.get(1)?,
                full_name: r.get(2)?,
                role: r.get(3)?,
                department: r.get(4)?,
                is_active: r.get::<_, i64>(5)? == 1,
                created_at: r.get(6)?,
            })
        },
    )?;

    Ok(created)
}

pub fn save_new_user_online_first(
    conn: &Connection,
    sync_server_url: Option<&str>,
    sync_token: Option<&str>,
    username: &str,
    raw_password: &str,
    role: &str,
    department: Option<&str>,
    college_uid: Option<&str>,
    college_name: Option<&str>,
    college_identification_number: Option<&str>,
    full_name: Option<&str>,
) -> Result<UserSummary, AppError> {
    apply_migration(conn)?;

    let canonical_username = normalize_upper(username);
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM users WHERE username = ?1",
            params![canonical_username],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Err(AppError::UserAlreadyExists);
    }

    let password_hash = hash_password(raw_password)?;
    let created_id = next_user_id(conn)?;
    let created_at = Utc::now().to_rfc3339();
    let password_hash_for_payload = password_hash.clone();
    let payload = json!({
        "id": created_id,
        "username": canonical_username,
        "password_hash": password_hash_for_payload,
        "role": role,
        "department": department,
        "college_uid": college_uid,
        "college_name": college_name,
        "college_identification_number": college_identification_number,
        "full_name": full_name,
        "internal_password_hash": Value::Null,
        "internal_password_required": true,
        "is_active": true,
        "created_at": created_at,
        "updated_at": created_at,
        "version": 1,
        "sync_state": "server_new"
    });

    let sync_attempt = sync_server_url.and_then(|url| {
        let trimmed_url = url.trim().trim_end_matches('/').to_string();
        if trimmed_url.is_empty() {
            return None;
        }

        Some((trimmed_url, sync_token.unwrap_or_default().to_string()))
    });

    if let Some((trimmed_url, token)) = sync_attempt {
        (|| -> Result<(), AppError> {
            let client = Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .map_err(|e| AppError::Http(format!("client build failed: {e}")))?;

            let outbox_id = created_id;
            let request = json!({
                "client_id": "stu-ls-desktop",
                "sent_at": created_at,
                "records": [{
                    "outbox_id": outbox_id,
                    "table_name": "users",
                    "record_id": created_id,
                    "operation": "insert",
                    "payload": payload,
                    "created_at": created_at,
                    "retries": 0
                }]
            });

            let mut http = client.post(format!("{trimmed_url}/sync/bridge")).json(&request);
            if !token.trim().is_empty() {
                http = http.bearer_auth(token.trim());
            }

            let response = http
                .send()
                .map_err(|e| AppError::Http(format!("sync request failed: {e}")))?;
            if !response.status().is_success() {
                return Err(AppError::Http(format!("sync server returned status {}", response.status())));
            }

            let sync_response: SyncPushResponse = response
                .json()
                .map_err(|e| AppError::Json(format!("invalid sync response: {e}")))?;
            if !sync_response.accepted_outbox_ids.contains(&outbox_id) {
                let rejection_reason = sync_response
                    .rejected
                    .as_ref()
                    .and_then(|items| items.iter().find(|item| item.outbox_id == outbox_id))
                    .map(|item| item.reason.clone())
                    .unwrap_or_else(|| "unknown rejection reason".to_string());
                return Err(AppError::Http(format!(
                    "user was not accepted by sync server: {}",
                    rejection_reason
                )));
            }

            Ok(())
        })()?;

            insert_local_user(
                conn,
                created_id,
                &canonical_username,
                &password_hash,
                role,
                department,
                college_uid,
                college_name,
                college_identification_number,
                full_name,
                "server_new",
            )?;
        let created = conn.query_row(
            "SELECT id, username, full_name, role, department, is_active, created_at FROM users WHERE id = ?1",
            params![created_id],
            |r| {
                Ok(UserSummary {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    full_name: r.get(2)?,
                    role: r.get(3)?,
                    department: r.get(4)?,
                    is_active: r.get::<_, i64>(5)? == 1,
                    created_at: r.get(6)?,
                })
            },
        )?;

        return Ok(created);
    }

    save_new_user(
        conn,
        username,
        raw_password,
        role,
        department,
        college_uid,
        college_name,
        college_identification_number,
        full_name,
    )
}

pub fn clear_local_data_except_platform_admin(conn: &Connection) -> Result<(), AppError> {
    apply_migration(conn)?;
    let already_reset: Option<String> = conn
        .query_row(
            "SELECT value FROM sync_metadata WHERE key = 'local_data_reset_done_v4'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if already_reset.as_deref() == Some("1") {
        return Ok(());
    }

    conn.execute_batch(
        "BEGIN;
         DELETE FROM course_progress_log;
         DELETE FROM attendance_records;
         DELETE FROM marks;
         DELETE FROM course_members;
         DELETE FROM enrollment_requests;
         DELETE FROM courses;
         DELETE FROM student_semesters;
         DELETE FROM student_lecturer_relationships;
         DELETE FROM student_admin_relationships;
         DELETE FROM students;
         DELETE FROM sync_outbox;
         DELETE FROM audit_log;
         DELETE FROM users WHERE lower(username) <> 'platformadmin';
         DELETE FROM sqlite_sequence WHERE name IN ('users','courses','enrollment_requests','course_members','attendance_records','marks','student_semesters','course_progress_log','sync_outbox','audit_log','students','student_lecturer_relationships','student_admin_relationships');
         COMMIT;"
    )?;

    conn.execute(
        "INSERT INTO sync_metadata (key, value) VALUES ('local_data_reset_done_v4', '1')\n         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')",
        [],
    )?;
    Ok(())
}