import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: process.env.SUPABASE_DB_URL ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX ?? 20)
});

const SUPPORTED_TABLES = new Set([
  "users",
  "courses",
  "course_members",
  "enrollment_requests",
  "attendance_records",
  "marks",
  "student_semesters",
  "course_progress_log"
]);

export async function getStorageHealth() {
  if (!process.env.SUPABASE_DB_URL) {
    return {
      ok: false,
      mode: "postgres",
      error: "SUPABASE_DB_URL is not configured"
    };
  }

  try {
    await pool.query("SELECT 1");
    return { ok: true, mode: "postgres" };
  } catch (error) {
    return {
      ok: false,
      mode: "postgres",
      error: error.message ?? "database health check failed"
    };
  }
}

export async function processBridgePayload(payload) {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("SUPABASE_DB_URL is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO public.sync_clients (client_id, last_seen_at)
      VALUES ($1, now())
      ON CONFLICT (client_id)
      DO UPDATE SET last_seen_at = now(), updated_at = now()
      `,
      [payload.client_id]
    );

    const accepted = [];
    const rejected = [];
    const impactedStudentIds = new Set();

    for (const item of payload.records ?? []) {
      if (!item || typeof item !== "object") {
        rejected.push({ outbox_id: -1, reason: "invalid record payload" });
        continue;
      }

      if (typeof item.outbox_id !== "number" || item.outbox_id <= 0) {
        rejected.push({ outbox_id: item.outbox_id ?? -1, reason: "invalid outbox_id" });
        continue;
      }

      if (!SUPPORTED_TABLES.has(item.table_name)) {
        rejected.push({ outbox_id: item.outbox_id, reason: "unsupported table_name" });
        continue;
      }

      let payloadObj;
      try {
        payloadObj = typeof item.payload === "string" ? JSON.parse(item.payload) : item.payload;
      } catch {
        rejected.push({ outbox_id: item.outbox_id, reason: "invalid payload json" });
        continue;
      }

      await client.query(
        `
        INSERT INTO public.sync_events (client_id, outbox_id, table_name, record_id, operation, payload, retries, received_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
        ON CONFLICT (client_id, outbox_id)
        DO UPDATE SET payload = EXCLUDED.payload,
                      operation = EXCLUDED.operation,
                      retries = EXCLUDED.retries,
                      received_at = EXCLUDED.received_at
        `,
        [
          payload.client_id,
          item.outbox_id,
          item.table_name,
          Number(item.record_id ?? payloadObj?.id ?? payloadObj?.student_user_id ?? 0),
          item.operation,
          JSON.stringify(payloadObj ?? {}),
          Number(item.retries ?? 0)
        ]
      );

      await applyDomainChange(client, item.table_name, item.operation, payloadObj ?? {});

      const impacted = await detectImpactedStudents(client, item.table_name, item.operation, payloadObj ?? {});
      for (const studentUserId of impacted) {
        impactedStudentIds.add(studentUserId);
      }

      if (item.table_name === "marks") {
        const studentUserId = Number(payloadObj?.student_user_id ?? 0);
        if (studentUserId > 0) {
          await createMarksNotification(client, studentUserId, payloadObj ?? {});
        }
      }

      accepted.push(item.outbox_id);
    }

    if (impactedStudentIds.size > 0) {
      const ids = Array.from(impactedStudentIds.values());
      await client.query(
        `
        INSERT INTO public.student_sync_state (student_user_id, update_available, last_change_at, change_counter)
        SELECT id, true, now(), 1
        FROM public.users
        WHERE id = ANY($1::bigint[])
        ON CONFLICT (student_user_id)
        DO UPDATE SET update_available = true,
                      last_change_at = now(),
                      change_counter = public.student_sync_state.change_counter + 1,
                      updated_at = now()
        `,
        [ids]
      );

      await client.query(
        `
        UPDATE public.users
        SET update_available = true,
            updated_at = now()
        WHERE id = ANY($1::bigint[])
        `,
        [ids]
      );
    }

    let pullChanges = [];
    let updateAvailable = false;
    let notifications = [];

    if (payload.actor_role === "student" && typeof payload.actor_username === "string") {
      const studentContext = await prepareStudentPull(client, payload.actor_username);
      updateAvailable = studentContext.updateAvailable;
      pullChanges = studentContext.pullChanges;
      notifications = studentContext.notifications;
    }

    await client.query("COMMIT");

    return {
      accepted_outbox_ids: accepted,
      rejected,
      pull_changes: pullChanges,
      update_available: updateAvailable,
      notifications
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyDomainChange(client, tableName, operation, record) {
  const id = Number(record.id ?? 0);
  const studentUserId = Number(record.student_user_id ?? 0);

  if (operation === "delete") {
    if (tableName === "users") {
      if (id <= 0) throw new Error("users.id missing for delete");
      await client.query(
        "UPDATE public.users SET is_active = false, sync_state = 'deleted', update_available = true, updated_at = now() WHERE id = $1",
        [id]
      );
      return;
    }

    if (tableName === "courses") {
      if (id <= 0) throw new Error("courses.id missing for delete");
      await client.query(
        "UPDATE public.courses SET status = 'ended', sync_state = 'deleted', updated_at = now() WHERE id = $1",
        [id]
      );
      return;
    }

    if (tableName === "course_members") {
      if (id <= 0) throw new Error("course_members.id missing for delete");
      await client.query(
        "UPDATE public.course_members SET removed_at = now(), sync_state = 'deleted', version = version + 1 WHERE id = $1",
        [id]
      );
      return;
    }

    if (tableName === "student_semesters") {
      if (studentUserId <= 0) throw new Error("student_semesters.student_user_id missing for delete");
      await client.query("DELETE FROM public.student_semesters WHERE student_user_id = $1", [studentUserId]);
      return;
    }

    const deleteId = id || studentUserId;
    if (deleteId <= 0) throw new Error(`${tableName}.id missing for delete`);
    await client.query(`DELETE FROM public.${tableName} WHERE id = $1`, [deleteId]);
    return;
  }

  if (tableName === "users") {
    await client.query(
      `
      INSERT INTO public.users (
        id, username, password_hash, role, department, is_active,
        college_uid, college_name, college_identification_number,
        full_name, internal_password_hash, internal_password_required,
        update_available, created_at, updated_at, version, sync_state
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        COALESCE($13, false), COALESCE($14::timestamptz, now()), COALESCE($15::timestamptz, now()), COALESCE($16, 1), COALESCE($17, 'server_new')
      )
      ON CONFLICT (id)
      DO UPDATE SET username = EXCLUDED.username,
                    password_hash = EXCLUDED.password_hash,
                    role = EXCLUDED.role,
                    department = EXCLUDED.department,
                    is_active = EXCLUDED.is_active,
                    college_uid = EXCLUDED.college_uid,
                    college_name = EXCLUDED.college_name,
                    college_identification_number = EXCLUDED.college_identification_number,
                    full_name = EXCLUDED.full_name,
                    internal_password_hash = EXCLUDED.internal_password_hash,
                    internal_password_required = EXCLUDED.internal_password_required,
                    updated_at = EXCLUDED.updated_at,
                    version = GREATEST(public.users.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.id),
        String(record.username ?? ""),
        String(record.password_hash ?? ""),
        String(record.role ?? "student"),
        record.department ?? null,
        Boolean(record.is_active ?? true),
        record.college_uid ?? null,
        record.college_name ?? null,
        record.college_identification_number ?? null,
        record.full_name ?? null,
        record.internal_password_hash ?? null,
        Boolean(record.internal_password_required ?? true),
        record.update_available ?? false,
        record.created_at ?? null,
        record.updated_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
    return;
  }

  if (tableName === "courses") {
    await client.query(
      `
      INSERT INTO public.courses (id, code, title, lecturer_user_id, department, semester, status, end_announced_at, created_at, updated_at, version, sync_state)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'active'), $8::timestamptz, COALESCE($9::timestamptz, now()), COALESCE($10::timestamptz, now()), COALESCE($11, 1), COALESCE($12, 'server_new'))
      ON CONFLICT (id)
      DO UPDATE SET code = EXCLUDED.code,
                    title = EXCLUDED.title,
                    lecturer_user_id = EXCLUDED.lecturer_user_id,
                    department = EXCLUDED.department,
                    semester = EXCLUDED.semester,
                    status = EXCLUDED.status,
                    end_announced_at = EXCLUDED.end_announced_at,
                    updated_at = EXCLUDED.updated_at,
                    version = GREATEST(public.courses.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.id),
        String(record.code ?? ""),
        String(record.title ?? ""),
        Number(record.lecturer_user_id ?? 0),
        record.department ?? null,
        Number(record.semester ?? 1),
        record.status ?? "active",
        record.end_announced_at ?? null,
        record.created_at ?? null,
        record.updated_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
    return;
  }

  if (tableName === "course_members") {
    await client.query(
      `
      INSERT INTO public.course_members (id, course_id, student_user_id, joined_at, removed_at, removal_deadline_at, version, sync_state)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5::timestamptz, $6::timestamptz, COALESCE($7, 1), COALESCE($8, 'server_new'))
      ON CONFLICT (id)
      DO UPDATE SET course_id = EXCLUDED.course_id,
                    student_user_id = EXCLUDED.student_user_id,
                    removed_at = EXCLUDED.removed_at,
                    removal_deadline_at = EXCLUDED.removal_deadline_at,
                    version = GREATEST(public.course_members.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.id),
        Number(record.course_id ?? 0),
        Number(record.student_user_id ?? 0),
        record.joined_at ?? null,
        record.removed_at ?? null,
        record.removal_deadline_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
    return;
  }

  if (tableName === "enrollment_requests") {
    await client.query(
      `
      INSERT INTO public.enrollment_requests (id, course_id, student_user_id, status, created_at, updated_at, version, sync_state)
      VALUES ($1, $2, $3, COALESCE($4, 'pending'), COALESCE($5::timestamptz, now()), COALESCE($6::timestamptz, now()), COALESCE($7, 1), COALESCE($8, 'server_new'))
      ON CONFLICT (id)
      DO UPDATE SET course_id = EXCLUDED.course_id,
                    student_user_id = EXCLUDED.student_user_id,
                    status = EXCLUDED.status,
                    updated_at = EXCLUDED.updated_at,
                    version = GREATEST(public.enrollment_requests.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.id),
        Number(record.course_id ?? 0),
        Number(record.student_user_id ?? 0),
        record.status ?? "pending",
        record.created_at ?? null,
        record.updated_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
    return;
  }

  if (tableName === "attendance_records") {
    await client.query(
      `
      INSERT INTO public.attendance_records (id, course_id, student_user_id, attendance_date, status, marked_by, created_at, version, sync_state)
      VALUES ($1, $2, $3, $4::date, $5, $6, COALESCE($7::timestamptz, now()), COALESCE($8, 1), COALESCE($9, 'server_new'))
      ON CONFLICT (id)
      DO UPDATE SET course_id = EXCLUDED.course_id,
                    student_user_id = EXCLUDED.student_user_id,
                    attendance_date = EXCLUDED.attendance_date,
                    status = EXCLUDED.status,
                    marked_by = EXCLUDED.marked_by,
                    version = GREATEST(public.attendance_records.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.id),
        Number(record.course_id ?? 0),
        Number(record.student_user_id ?? 0),
        record.attendance_date,
        record.status,
        Number(record.marked_by ?? 0),
        record.created_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
    return;
  }

  if (tableName === "marks") {
    await client.query(
      `
      INSERT INTO public.marks (id, course_id, student_user_id, internal_marks, external_marks, lecturer_decision, updated_by, updated_at, version, sync_state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), COALESCE($9, 1), COALESCE($10, 'server_new'))
      ON CONFLICT (id)
      DO UPDATE SET course_id = EXCLUDED.course_id,
                    student_user_id = EXCLUDED.student_user_id,
                    internal_marks = EXCLUDED.internal_marks,
                    external_marks = EXCLUDED.external_marks,
                    lecturer_decision = EXCLUDED.lecturer_decision,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = EXCLUDED.updated_at,
                    version = GREATEST(public.marks.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.id),
        Number(record.course_id ?? 0),
        Number(record.student_user_id ?? 0),
        record.internal_marks ?? null,
        record.external_marks ?? null,
        record.lecturer_decision ?? null,
        Number(record.updated_by ?? record.student_user_id ?? 0),
        record.updated_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
    return;
  }

  if (tableName === "student_semesters") {
    await client.query(
      `
      INSERT INTO public.student_semesters (student_user_id, current_semester, updated_at, version, sync_state)
      VALUES ($1, COALESCE($2, 1), COALESCE($3::timestamptz, now()), COALESCE($4, 1), COALESCE($5, 'server_new'))
      ON CONFLICT (student_user_id)
      DO UPDATE SET current_semester = EXCLUDED.current_semester,
                    updated_at = EXCLUDED.updated_at,
                    version = GREATEST(public.student_semesters.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.student_user_id),
        Number(record.current_semester ?? 1),
        record.updated_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
    return;
  }

  if (tableName === "course_progress_log") {
    await client.query(
      `
      INSERT INTO public.course_progress_log (id, course_id, lecturer_user_id, progress_text, progress_date, created_at, version, sync_state)
      VALUES ($1, $2, $3, $4, COALESCE($5::date, current_date), COALESCE($6::timestamptz, now()), COALESCE($7, 1), COALESCE($8, 'server_new'))
      ON CONFLICT (id)
      DO UPDATE SET course_id = EXCLUDED.course_id,
                    lecturer_user_id = EXCLUDED.lecturer_user_id,
                    progress_text = EXCLUDED.progress_text,
                    progress_date = EXCLUDED.progress_date,
                    created_at = EXCLUDED.created_at,
                    version = GREATEST(public.course_progress_log.version, EXCLUDED.version),
                    sync_state = EXCLUDED.sync_state
      `,
      [
        Number(record.id),
        Number(record.course_id ?? 0),
        Number(record.lecturer_user_id ?? 0),
        String(record.progress_text ?? ""),
        record.progress_date ?? null,
        record.created_at ?? null,
        Number(record.version ?? 1),
        record.sync_state ?? "server_new"
      ]
    );
  }
}

async function detectImpactedStudents(client, tableName, operation, record) {
  const out = new Set();

  if (tableName === "marks" || tableName === "attendance_records" || tableName === "enrollment_requests" || tableName === "student_semesters") {
    const id = Number(record.student_user_id ?? 0);
    if (id > 0) {
      out.add(id);
    }
    return out;
  }

  if (tableName === "course_members") {
    const id = Number(record.student_user_id ?? 0);
    if (id > 0) {
      out.add(id);
      return out;
    }

    const memberId = Number(record.id ?? 0);
    if (memberId > 0) {
      const result = await client.query("SELECT student_user_id FROM public.course_members WHERE id = $1", [memberId]);
      for (const row of result.rows) {
        out.add(Number(row.student_user_id));
      }
    }
    return out;
  }

  if (tableName === "users") {
    const userId = Number(record.id ?? 0);
    if (userId > 0) {
      if (String(record.role ?? "") === "student") {
        out.add(userId);
        return out;
      }

      const lookup = await client.query("SELECT role FROM public.users WHERE id = $1", [userId]);
      if (lookup.rows[0]?.role === "student") {
        out.add(userId);
      }
    }
    return out;
  }

  if (tableName === "courses" || tableName === "course_progress_log") {
    const courseId = Number(record.course_id ?? record.id ?? 0);
    if (courseId > 0) {
      const result = await client.query(
        "SELECT student_user_id FROM public.course_members WHERE course_id = $1 AND removed_at IS NULL",
        [courseId]
      );
      for (const row of result.rows) {
        out.add(Number(row.student_user_id));
      }
    }
    return out;
  }

  if (operation === "delete") {
    const fallbackStudentId = Number(record.student_user_id ?? 0);
    if (fallbackStudentId > 0) {
      out.add(fallbackStudentId);
    }
  }

  return out;
}

async function createMarksNotification(client, studentUserId, marksRecord) {
  await client.query(
    `
    INSERT INTO public.student_notifications (student_user_id, event_type, message, payload)
    VALUES ($1, 'marks_updated', $2, $3::jsonb)
    `,
    [
      studentUserId,
      "Marks were updated. Refresh your desktop app to view the latest scores.",
      JSON.stringify({
        mark_id: marksRecord.id ?? null,
        course_id: marksRecord.course_id ?? null,
        internal_marks: marksRecord.internal_marks ?? null,
        external_marks: marksRecord.external_marks ?? null,
        lecturer_decision: marksRecord.lecturer_decision ?? null
      })
    ]
  );
}

async function prepareStudentPull(client, actorUsername) {
  const userResult = await client.query(
    "SELECT id FROM public.users WHERE username = $1 AND role = 'student' AND is_active = true LIMIT 1",
    [actorUsername]
  );

  const studentUserId = Number(userResult.rows[0]?.id ?? 0);
  if (studentUserId <= 0) {
    return {
      updateAvailable: false,
      pullChanges: [],
      notifications: []
    };
  }

  const flagResult = await client.query(
    `
    SELECT COALESCE(ss.update_available, u.update_available, false) AS update_available
    FROM public.users u
    LEFT JOIN public.student_sync_state ss ON ss.student_user_id = u.id
    WHERE u.id = $1
    `,
    [studentUserId]
  );

  const updateAvailable = Boolean(flagResult.rows[0]?.update_available);

  const notifications = await fetchAndMarkNotifications(client, studentUserId);
  if (!updateAvailable) {
    return {
      updateAvailable: false,
      pullChanges: [],
      notifications
    };
  }

  const pullChanges = await collectStudentSnapshotChanges(client, studentUserId);

  await client.query(
    `
    UPDATE public.users
    SET update_available = false,
        updated_at = now()
    WHERE id = $1
    `,
    [studentUserId]
  );

  await client.query(
    `
    INSERT INTO public.student_sync_state (student_user_id, update_available, last_pulled_at, last_change_at, change_counter)
    VALUES ($1, false, now(), now(), 0)
    ON CONFLICT (student_user_id)
    DO UPDATE SET update_available = false,
                  last_pulled_at = now(),
                  updated_at = now()
    `,
    [studentUserId]
  );

  return {
    updateAvailable: true,
    pullChanges,
    notifications
  };
}

async function fetchAndMarkNotifications(client, studentUserId) {
  const rows = await client.query(
    `
    SELECT id, event_type, message, payload, created_at
    FROM public.student_notifications
    WHERE student_user_id = $1 AND is_read = false
    ORDER BY id ASC
    LIMIT 50
    `,
    [studentUserId]
  );

  const ids = rows.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
  if (ids.length > 0) {
    await client.query(
      "UPDATE public.student_notifications SET is_read = true, read_at = now() WHERE id = ANY($1::bigint[])",
      [ids]
    );
  }

  return rows.rows.map((row) => ({
    id: Number(row.id),
    event_type: row.event_type,
    message: row.message,
    payload: row.payload,
    created_at: row.created_at
  }));
}

async function collectStudentSnapshotChanges(client, studentUserId) {
  const changes = [];

  const userRows = await client.query(
    `
    SELECT id, username, password_hash, role, department, is_active,
           college_uid, college_name, college_identification_number,
           full_name, internal_password_hash, internal_password_required,
           created_at, updated_at, version, sync_state
    FROM public.users
    WHERE id = $1
    `,
    [studentUserId]
  );
  for (const row of userRows.rows) {
    changes.push({ table_name: "users", operation: "update", record: row });
  }

  const semesterRows = await client.query(
    "SELECT student_user_id, current_semester, updated_at, version, sync_state FROM public.student_semesters WHERE student_user_id = $1",
    [studentUserId]
  );
  for (const row of semesterRows.rows) {
    changes.push({ table_name: "student_semesters", operation: "update", record: row });
  }

  const courseMemberRows = await client.query(
    `
    SELECT id, course_id, student_user_id, joined_at, removed_at, removal_deadline_at, version, sync_state
    FROM public.course_members
    WHERE student_user_id = $1
    `,
    [studentUserId]
  );
  for (const row of courseMemberRows.rows) {
    changes.push({ table_name: "course_members", operation: "update", record: row });
  }

  const courseRows = await client.query(
    `
    SELECT c.id, c.code, c.title, c.lecturer_user_id, c.department, c.semester, c.status,
           c.end_announced_at, c.created_at, c.updated_at, c.version, c.sync_state
    FROM public.courses c
    JOIN public.course_members cm ON cm.course_id = c.id
    WHERE cm.student_user_id = $1
    GROUP BY c.id
    `,
    [studentUserId]
  );
  for (const row of courseRows.rows) {
    changes.push({ table_name: "courses", operation: "update", record: row });
  }

  const enrollmentRows = await client.query(
    `
    SELECT id, course_id, student_user_id, status, created_at, updated_at, version, sync_state
    FROM public.enrollment_requests
    WHERE student_user_id = $1
    `,
    [studentUserId]
  );
  for (const row of enrollmentRows.rows) {
    changes.push({ table_name: "enrollment_requests", operation: "update", record: row });
  }

  const attendanceRows = await client.query(
    `
    SELECT id, course_id, student_user_id, attendance_date, status, marked_by, created_at, version, sync_state
    FROM public.attendance_records
    WHERE student_user_id = $1
    `,
    [studentUserId]
  );
  for (const row of attendanceRows.rows) {
    changes.push({ table_name: "attendance_records", operation: "update", record: row });
  }

  const markRows = await client.query(
    `
    SELECT id, course_id, student_user_id, internal_marks, external_marks, lecturer_decision, updated_by, updated_at, version, sync_state
    FROM public.marks
    WHERE student_user_id = $1
    `,
    [studentUserId]
  );
  for (const row of markRows.rows) {
    changes.push({ table_name: "marks", operation: "update", record: row });
  }

  return changes;
}
