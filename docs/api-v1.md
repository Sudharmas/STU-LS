# STU-LS API Reference

This file contains the required API surface for both desktop command calls and hosted sync endpoint calls.

## 1. Desktop Command API (Tauri)

### 1.1 Foundation
1. `initialize_system()`
2. `seed_platform_admin(username, password)`
3. `seed_full_sync_snapshot()`
4. `get_sync_stats()` -> `[pending, sent, failed]`
5. `process_outbox_and_sync(server_base_url, auth_token, batch_size, actor_username, actor_role, dry_run)`

### 1.2 Authentication
1. `login(username, password)`
2. `login_student(username, password)`
3. `login_admin(username, password)`
4. `login_lecturer(username, password)`
5. `login_platform_admin(username, password)`
6. `is_internal_password_setup_required(username)`
7. `set_internal_password(username, internal_password, confirm_password)`

### 1.3 User and Profile Management
1. `create_user(actor_username, username, password, role, department, full_name, college_name, college_identification_number, internal_password, sync_server_url, sync_token)`
2. `update_user(actor_username, target_username, new_password, new_department, is_active, internal_password, sync_server_url, sync_token)`
3. `delete_user(actor_username, target_username, internal_password)`
4. `list_users(actor_username, role_filter)`
5. `update_my_profile_name(actor_username, full_name)`

### 1.4 Bulk Provisioning
1. `create_lecturer_with_unique_number(actor_username, sync_server_url, sync_token)`
2. `create_department_admin_with_unique_number(actor_username, department, sync_server_url, sync_token)`
3. `start_bulk_create_lecturers_job(actor_username, lecturer_count)`
4. `start_bulk_create_students_from_usns_job(actor_username, usns)`
5. `start_bulk_create_students_by_range_job(actor_username, student_year, from_number, to_number, pad_width)`
6. `get_bulk_job_status(job_id)`
7. `get_department_admin_bulk_defaults(actor_username)`

Student ID format from range flow:
- `<college_code><year_2_digits><department_code><padded_sequence>`
- Example: `4SN22CD001`

### 1.5 Courses, Enrollment, Attendance, Marks
1. `create_course(actor_username, code, title, department, semester)`
2. `list_courses(actor_username, include_ended)`
3. `list_course_catalog(actor_username)`
4. `request_course_join(actor_username, course_id)`
5. `list_pending_enrollment_requests(actor_username)`
6. `handle_enrollment_request(actor_username, request_id, approve)`
7. `end_course(actor_username, course_id, confirmation)`
8. `acknowledge_ended_course(actor_username, course_id)`
9. `cleanup_expired_ended_courses()`
10. `mark_attendance_bulk(actor_username, course_id, entries)`
11. `upsert_internal_marks(actor_username, course_id, student_username, internal_marks)`
12. `submit_external_marks(actor_username, course_id, external_marks)`
13. `decide_student_result(actor_username, course_id, student_username, decision)`
14. `append_course_progress(actor_username, course_id, progress_text)`
15. `promote_or_reset_student_semester(actor_username, student_username, force_promote)`
16. `get_student_dashboard(actor_username)`

### 1.6 Student Table and Relationship Commands
1. `get_student_by_user_id(actor_username, user_id)`
2. `get_students_by_department(actor_username, department, enrollment_status)`
3. `get_students_by_admin(actor_username, admin_user_id)`
4. `get_students_by_lecturer(actor_username, lecturer_user_id)`
5. `update_student_enrollment_status(actor_username, student_id, enrollment_status)`
6. `update_student_semester(actor_username, student_id, semester)`
7. `add_student_lecturer_relationship(actor_username, student_id, lecturer_user_id, relationship_type)`
8. `clear_all_local_students(actor_username)`

### 1.7 Export
1. `export_course_data(actor_username, department, semester, course_id, format, output_path)`

## 2. Backend Server API

Base URL:
1. Local: `http://localhost:8090`
2. Hosted: Render service URL

Auth:
1. If `BACKEND_SERVER_BEARER_TOKEN` is configured, send `Authorization: Bearer <token>`.

### 2.1 Health
1. `GET /health`

Success:
```json
{
  "ok": true,
  "service": "stu-ls-backend-server",
  "mode": "postgres"
}
```

### 2.2 Unified Sync Bridge
1. `POST /sync/bridge`

Minimal request:
```json
{
  "client_id": "stu-ls-desktop",
  "actor_username": "S01",
  "actor_role": "student",
  "records": []
}
```

Request with outbox records:
```json
{
  "client_id": "stu-ls-desktop",
  "actor_username": "LECT001",
  "actor_role": "lecturer",
  "sent_at": "2026-04-22T07:30:00Z",
  "records": [
    {
      "outbox_id": 101,
      "table_name": "marks",
      "record_id": 9001,
      "operation": "update",
      "payload": "{\"id\":9001,\"course_id\":15,\"student_user_id\":88,\"internal_marks\":46,\"external_marks\":40,\"lecturer_decision\":\"pass\",\"updated_by\":12}",
      "created_at": "2026-04-22T07:29:00Z",
      "retries": 0
    }
  ]
}
```

Response shape:
```json
{
  "accepted_outbox_ids": [101],
  "rejected": [],
  "pull_changes": [],
  "update_available": true,
  "notifications": []
}
```

Error examples:
1. `400` invalid request body.
2. `401` unauthorized (token mismatch).
3. `500` sync bridge internal error.

## 3. Client Integration Rules
1. Always include `actor_username` and `actor_role` when syncing.
2. Apply every `pull_changes` record locally.
3. Mark accepted outbox rows as sent using `accepted_outbox_ids`.
4. Retry rejected rows using your retry policy.
5. For students, treat `update_available=true` as a pull-required state and refresh dashboard data.
