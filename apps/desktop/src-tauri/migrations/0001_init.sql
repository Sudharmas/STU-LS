PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('platform_admin', 'super_admin', 'department_admin', 'lecturer', 'student')),
  department TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new'
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  lecturer_user_id INTEGER NOT NULL,
  department TEXT,
  semester INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'ending', 'ended')) DEFAULT 'active',
  end_announced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  UNIQUE(code, lecturer_user_id),
  FOREIGN KEY (lecturer_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS enrollment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  student_user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  UNIQUE(course_id, student_user_id),
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (student_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS course_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  student_user_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at TEXT,
  removal_deadline_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  UNIQUE(course_id, student_user_id),
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (student_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  student_user_id INTEGER NOT NULL,
  attendance_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('P', 'A')),
  marked_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  UNIQUE(course_id, student_user_id, attendance_date),
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (student_user_id) REFERENCES users(id),
  FOREIGN KEY (marked_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  student_user_id INTEGER NOT NULL,
  internal_marks INTEGER CHECK (internal_marks >= 0 AND internal_marks <= 50),
  external_marks INTEGER CHECK (external_marks >= 0 AND external_marks <= 50),
  lecturer_decision TEXT CHECK (lecturer_decision IN ('pass', 'fail', 'override_pass')),
  updated_by INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  UNIQUE(course_id, student_user_id),
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (student_user_id) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retries INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_username TEXT NOT NULL,
  action TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
