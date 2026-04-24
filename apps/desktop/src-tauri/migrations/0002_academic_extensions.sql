PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS student_semesters (
  student_user_id INTEGER PRIMARY KEY,
  current_semester INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  FOREIGN KEY (student_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS course_progress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lecturer_user_id INTEGER NOT NULL,
  progress_text TEXT NOT NULL,
  progress_date TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (lecturer_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_course_members_active ON course_members(course_id, student_user_id, removed_at);
CREATE INDEX IF NOT EXISTS idx_attendance_course_student ON attendance_records(course_id, student_user_id);
CREATE INDEX IF NOT EXISTS idx_marks_course_student ON marks(course_id, student_user_id);
