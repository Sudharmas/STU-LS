-- Dedicated Students Table with Relationships
-- This table stores student-specific data separate from users table
-- Allows for optimized queries and better data integrity

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  department TEXT NOT NULL,
  college_uid TEXT NOT NULL,
  college_name TEXT,
  college_identification_number TEXT,
  created_by_admin_id INTEGER NOT NULL,
  current_semester INTEGER NOT NULL DEFAULT 1,
  enrollment_status TEXT NOT NULL CHECK (enrollment_status IN ('active', 'inactive', 'graduated', 'suspended')) DEFAULT 'active',
  academic_year TEXT,
  batch TEXT,
  custom_metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_admin_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_students_user_id ON students(user_id);
CREATE INDEX IF NOT EXISTS idx_students_department ON students(department);
CREATE INDEX IF NOT EXISTS idx_students_college_uid ON students(college_uid);
CREATE INDEX IF NOT EXISTS idx_students_created_by_admin_id ON students(created_by_admin_id);
CREATE INDEX IF NOT EXISTS idx_students_enrollment_status ON students(enrollment_status);
CREATE INDEX IF NOT EXISTS idx_students_batch ON students(batch);
CREATE INDEX IF NOT EXISTS idx_students_college_and_status ON students(college_uid, enrollment_status);
CREATE INDEX IF NOT EXISTS idx_students_department_status ON students(department, enrollment_status);

-- Student-Lecturer Relationship (for quick enrollment lookups)
CREATE TABLE IF NOT EXISTS student_lecturer_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  lecturer_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('enrolled', 'assigned', 'supervised')) DEFAULT 'enrolled',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  UNIQUE(student_id, lecturer_id, relationship_type),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (lecturer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_student_lecturer_student_id ON student_lecturer_relationships(student_id);
CREATE INDEX IF NOT EXISTS idx_student_lecturer_lecturer_id ON student_lecturer_relationships(lecturer_id);
CREATE INDEX IF NOT EXISTS idx_student_lecturer_type ON student_lecturer_relationships(relationship_type);

-- Student-Department Admin Relationship (for quick admin lookups)
CREATE TABLE IF NOT EXISTS student_admin_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  admin_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('created_by', 'managed_by', 'advised_by')) DEFAULT 'created_by',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'local_new',
  UNIQUE(student_id, admin_id, relationship_type),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_student_admin_student_id ON student_admin_relationships(student_id);
CREATE INDEX IF NOT EXISTS idx_student_admin_admin_id ON student_admin_relationships(admin_id);
CREATE INDEX IF NOT EXISTS idx_student_admin_type ON student_admin_relationships(relationship_type);
