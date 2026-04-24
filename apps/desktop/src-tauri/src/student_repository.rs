use super::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StudentRow {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub full_name: Option<String>,
    pub department: String,
    pub college_uid: String,
    pub college_name: Option<String>,
    pub college_identification_number: Option<String>,
    pub created_by_admin_id: i64,
    pub created_by_admin_username: String,
    pub current_semester: i32,
    pub enrollment_status: String,
    pub academic_year: Option<String>,
    pub batch: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub version: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StudentWithRelationships {
    pub student: StudentRow,
    pub lecturers: Vec<LecturerRelationship>,
    pub admins: Vec<AdminRelationship>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LecturerRelationship {
    pub lecturer_id: i64,
    pub lecturer_username: String,
    pub lecturer_name: Option<String>,
    pub relationship_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdminRelationship {
    pub admin_id: i64,
    pub admin_username: String,
    pub admin_name: Option<String>,
    pub relationship_type: String,
}

/// Insert a new student record after user creation
pub fn insert_student(
    conn: &Connection,
    user_id: i64,
    department: &str,
    college_uid: &str,
    college_name: Option<&str>,
    college_identification_number: Option<&str>,
    created_by_admin_id: i64,
    academic_year: Option<&str>,
    batch: Option<&str>,
) -> Result<i64, AppError> {
    let next_id: i64 = conn
        .query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM students", [], |r| r.get(0))?;

    conn.execute(
        "INSERT INTO students (id, user_id, department, college_uid, college_name, college_identification_number, created_by_admin_id, academic_year, batch, sync_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'local_new')",
        params![
            next_id,
            user_id,
            department,
            college_uid,
            college_name,
            college_identification_number,
            created_by_admin_id,
            academic_year,
            batch,
        ],
    )?;

    // Auto-create primary relationship: created_by
    create_student_admin_relationship(
        conn,
        next_id,
        created_by_admin_id,
        "created_by",
    )?;

    Ok(next_id)
}

/// Get a student by user_id with all relationships
pub fn get_student_by_user_id(
    conn: &Connection,
    user_id: i64,
) -> Result<StudentWithRelationships, AppError> {
    let student = conn
        .query_row(
            "SELECT s.id, s.user_id, u.username, u.full_name, s.department, s.college_uid,
                    s.college_name, s.college_identification_number, s.created_by_admin_id,
                    admin.username, s.current_semester, s.enrollment_status, s.academic_year,
                    s.batch, s.created_at, s.updated_at, s.version
             FROM students s
             INNER JOIN users u ON s.user_id = u.id
             INNER JOIN users admin ON s.created_by_admin_id = admin.id
             WHERE s.user_id = ?1",
            params![user_id],
            |r| {
                Ok(StudentRow {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    username: r.get(2)?,
                    full_name: r.get(3)?,
                    department: r.get(4)?,
                    college_uid: r.get(5)?,
                    college_name: r.get(6)?,
                    college_identification_number: r.get(7)?,
                    created_by_admin_id: r.get(8)?,
                    created_by_admin_username: r.get(9)?,
                    current_semester: r.get(10)?,
                    enrollment_status: r.get(11)?,
                    academic_year: r.get(12)?,
                    batch: r.get(13)?,
                    created_at: r.get(14)?,
                    updated_at: r.get(15)?,
                    version: r.get(16)?,
                })
            },
        )
        .optional()?
        .ok_or(AppError::TargetNotFound)?;

    let lecturers = get_student_lecturers(conn, student.id)?;
    let admins = get_student_admins(conn, student.id)?;

    Ok(StudentWithRelationships {
        student,
        lecturers,
        admins,
    })
}

/// Get all students for a department with optional status filter
pub fn get_students_by_department(
    conn: &Connection,
    department: &str,
    enrollment_status: Option<&str>,
) -> Result<Vec<StudentRow>, AppError> {
    let query = if let Some(status) = enrollment_status {
        format!(
            "SELECT s.id, s.user_id, u.username, u.full_name, s.department, s.college_uid,
                    s.college_name, s.college_identification_number, s.created_by_admin_id,
                    admin.username, s.current_semester, s.enrollment_status, s.academic_year,
                    s.batch, s.created_at, s.updated_at, s.version
             FROM students s
             INNER JOIN users u ON s.user_id = u.id
             INNER JOIN users admin ON s.created_by_admin_id = admin.id
             WHERE s.department = '{}' AND s.enrollment_status = '{}'
             ORDER BY s.created_at DESC",
            department, status
        )
    } else {
        format!(
            "SELECT s.id, s.user_id, u.username, u.full_name, s.department, s.college_uid,
                    s.college_name, s.college_identification_number, s.created_by_admin_id,
                    admin.username, s.current_semester, s.enrollment_status, s.academic_year,
                    s.batch, s.created_at, s.updated_at, s.version
             FROM students s
             INNER JOIN users u ON s.user_id = u.id
             INNER JOIN users admin ON s.created_by_admin_id = admin.id
             WHERE s.department = '{}'
             ORDER BY s.created_at DESC",
            department
        )
    };

    let mut stmt = conn.prepare(&query)?;
    let students = stmt
        .query_map([], |r| {
            Ok(StudentRow {
                id: r.get(0)?,
                user_id: r.get(1)?,
                username: r.get(2)?,
                full_name: r.get(3)?,
                department: r.get(4)?,
                college_uid: r.get(5)?,
                college_name: r.get(6)?,
                college_identification_number: r.get(7)?,
                created_by_admin_id: r.get(8)?,
                created_by_admin_username: r.get(9)?,
                current_semester: r.get(10)?,
                enrollment_status: r.get(11)?,
                academic_year: r.get(12)?,
                batch: r.get(13)?,
                created_at: r.get(14)?,
                updated_at: r.get(15)?,
                version: r.get(16)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(students)
}

/// Get all students created by a specific admin
pub fn get_students_by_admin(
    conn: &Connection,
    admin_user_id: i64,
) -> Result<Vec<StudentRow>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.user_id, u.username, u.full_name, s.department, s.college_uid,
                s.college_name, s.college_identification_number, s.created_by_admin_id,
                admin.username, s.current_semester, s.enrollment_status, s.academic_year,
                s.batch, s.created_at, s.updated_at, s.version
         FROM students s
         INNER JOIN users u ON s.user_id = u.id
         INNER JOIN users admin ON s.created_by_admin_id = admin.id
         WHERE s.created_by_admin_id = ?1
         ORDER BY s.created_at DESC",
    )?;

    let students = stmt
        .query_map(params![admin_user_id], |r| {
            Ok(StudentRow {
                id: r.get(0)?,
                user_id: r.get(1)?,
                username: r.get(2)?,
                full_name: r.get(3)?,
                department: r.get(4)?,
                college_uid: r.get(5)?,
                college_name: r.get(6)?,
                college_identification_number: r.get(7)?,
                created_by_admin_id: r.get(8)?,
                created_by_admin_username: r.get(9)?,
                current_semester: r.get(10)?,
                enrollment_status: r.get(11)?,
                academic_year: r.get(12)?,
                batch: r.get(13)?,
                created_at: r.get(14)?,
                updated_at: r.get(15)?,
                version: r.get(16)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(students)
}

/// Get all students in a college with optional status filter
pub fn get_students_by_college(
    conn: &Connection,
    college_uid: &str,
    enrollment_status: Option<&str>,
) -> Result<Vec<StudentRow>, AppError> {
    let query = if let Some(status) = enrollment_status {
        format!(
            "SELECT s.id, s.user_id, u.username, u.full_name, s.department, s.college_uid,
                    s.college_name, s.college_identification_number, s.created_by_admin_id,
                    admin.username, s.current_semester, s.enrollment_status, s.academic_year,
                    s.batch, s.created_at, s.updated_at, s.version
             FROM students s
             INNER JOIN users u ON s.user_id = u.id
             INNER JOIN users admin ON s.created_by_admin_id = admin.id
             WHERE s.college_uid = '{}' AND s.enrollment_status = '{}'
             ORDER BY s.created_at DESC",
            college_uid, status
        )
    } else {
        format!(
            "SELECT s.id, s.user_id, u.username, u.full_name, s.department, s.college_uid,
                    s.college_name, s.college_identification_number, s.created_by_admin_id,
                    admin.username, s.current_semester, s.enrollment_status, s.academic_year,
                    s.batch, s.created_at, s.updated_at, s.version
             FROM students s
             INNER JOIN users u ON s.user_id = u.id
             INNER JOIN users admin ON s.created_by_admin_id = admin.id
             WHERE s.college_uid = '{}'
             ORDER BY s.created_at DESC",
            college_uid
        )
    };

    let mut stmt = conn.prepare(&query)?;
    let students = stmt
        .query_map([], |r| {
            Ok(StudentRow {
                id: r.get(0)?,
                user_id: r.get(1)?,
                username: r.get(2)?,
                full_name: r.get(3)?,
                department: r.get(4)?,
                college_uid: r.get(5)?,
                college_name: r.get(6)?,
                college_identification_number: r.get(7)?,
                created_by_admin_id: r.get(8)?,
                created_by_admin_username: r.get(9)?,
                current_semester: r.get(10)?,
                enrollment_status: r.get(11)?,
                academic_year: r.get(12)?,
                batch: r.get(13)?,
                created_at: r.get(14)?,
                updated_at: r.get(15)?,
                version: r.get(16)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(students)
}

/// Get students enrolled with a specific lecturer
pub fn get_students_by_lecturer(
    conn: &Connection,
    lecturer_user_id: i64,
) -> Result<Vec<StudentRow>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT s.id, s.user_id, u.username, u.full_name, s.department, s.college_uid,
                s.college_name, s.college_identification_number, s.created_by_admin_id,
                admin.username, s.current_semester, s.enrollment_status, s.academic_year,
                s.batch, s.created_at, s.updated_at, s.version
         FROM students s
         INNER JOIN users u ON s.user_id = u.id
         INNER JOIN users admin ON s.created_by_admin_id = admin.id
         INNER JOIN student_lecturer_relationships slr ON s.id = slr.student_id
         WHERE slr.lecturer_id = ?1 AND slr.relationship_type = 'enrolled'
         ORDER BY s.created_at DESC",
    )?;

    let students = stmt
        .query_map(params![lecturer_user_id], |r| {
            Ok(StudentRow {
                id: r.get(0)?,
                user_id: r.get(1)?,
                username: r.get(2)?,
                full_name: r.get(3)?,
                department: r.get(4)?,
                college_uid: r.get(5)?,
                college_name: r.get(6)?,
                college_identification_number: r.get(7)?,
                created_by_admin_id: r.get(8)?,
                created_by_admin_username: r.get(9)?,
                current_semester: r.get(10)?,
                enrollment_status: r.get(11)?,
                academic_year: r.get(12)?,
                batch: r.get(13)?,
                created_at: r.get(14)?,
                updated_at: r.get(15)?,
                version: r.get(16)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(students)
}

/// Create a relationship between student and lecturer
pub fn create_student_lecturer_relationship(
    conn: &Connection,
    student_id: i64,
    lecturer_id: i64,
    relationship_type: &str,
) -> Result<i64, AppError> {
    let next_id: i64 = conn.query_row(
        "SELECT COALESCE(MAX(id), 0) + 1 FROM student_lecturer_relationships",
        [],
        |r| r.get(0),
    )?;

    conn.execute(
        "INSERT INTO student_lecturer_relationships (id, student_id, lecturer_id, relationship_type, sync_state)
         VALUES (?1, ?2, ?3, ?4, 'local_new')",
        params![next_id, student_id, lecturer_id, relationship_type],
    )?;

    Ok(next_id)
}

/// Create a relationship between student and admin
pub fn create_student_admin_relationship(
    conn: &Connection,
    student_id: i64,
    admin_id: i64,
    relationship_type: &str,
) -> Result<i64, AppError> {
    let next_id: i64 = conn.query_row(
        "SELECT COALESCE(MAX(id), 0) + 1 FROM student_admin_relationships",
        [],
        |r| r.get(0),
    )?;

    conn.execute(
        "INSERT INTO student_admin_relationships (id, student_id, admin_id, relationship_type, sync_state)
         VALUES (?1, ?2, ?3, ?4, 'local_new')",
        params![next_id, student_id, admin_id, relationship_type],
    )?;

    Ok(next_id)
}

/// Get all lecturers related to a student
fn get_student_lecturers(
    conn: &Connection,
    student_id: i64,
) -> Result<Vec<LecturerRelationship>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT u.id, u.username, u.full_name, slr.relationship_type
         FROM student_lecturer_relationships slr
         INNER JOIN users u ON slr.lecturer_id = u.id
         WHERE slr.student_id = ?1",
    )?;

    let lecturers = stmt
        .query_map(params![student_id], |r| {
            Ok(LecturerRelationship {
                lecturer_id: r.get(0)?,
                lecturer_username: r.get(1)?,
                lecturer_name: r.get(2)?,
                relationship_type: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(lecturers)
}

/// Get all admins related to a student
fn get_student_admins(
    conn: &Connection,
    student_id: i64,
) -> Result<Vec<AdminRelationship>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT u.id, u.username, u.full_name, sar.relationship_type
         FROM student_admin_relationships sar
         INNER JOIN users u ON sar.admin_id = u.id
         WHERE sar.student_id = ?1",
    )?;

    let admins = stmt
        .query_map(params![student_id], |r| {
            Ok(AdminRelationship {
                admin_id: r.get(0)?,
                admin_username: r.get(1)?,
                admin_name: r.get(2)?,
                relationship_type: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(admins)
}

/// Update student enrollment status
pub fn update_student_enrollment_status(
    conn: &Connection,
    student_id: i64,
    enrollment_status: &str,
) -> Result<(), AppError> {
    conn.execute(
        "UPDATE students SET enrollment_status = ?1, updated_at = datetime('now'), sync_state = 'local_updated' WHERE id = ?2",
        params![enrollment_status, student_id],
    )?;
    Ok(())
}

/// Update student semester
pub fn update_student_semester(
    conn: &Connection,
    student_id: i64,
    semester: i32,
) -> Result<(), AppError> {
    conn.execute(
        "UPDATE students SET current_semester = ?1, updated_at = datetime('now'), sync_state = 'local_updated' WHERE id = ?2",
        params![semester, student_id],
    )?;
    Ok(())
}
