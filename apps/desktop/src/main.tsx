import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UserRole } from "../../../packages/contracts/src";
import { extractUsnsFromWorkbookBuffer } from "./lib/parsers";
import "./styles.css";

const DEFAULT_SYNC_URL = (import.meta.env.VITE_SYNC_SERVER_URL as string | undefined) ?? "http://localhost:8090";
const SYNC_FALLBACK_URLS = ((import.meta.env.VITE_SYNC_FALLBACK_URLS as string | undefined) ?? "http://localhost:8090")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const SYNC_URL_CANDIDATES = Array.from(new Set([DEFAULT_SYNC_URL.trim(), ...SYNC_FALLBACK_URLS]));
const DEFAULT_SYNC_TOKEN = (import.meta.env.VITE_SYNC_BEARER_TOKEN as string | undefined) ?? "";
const SESSION_STORAGE_KEY = "stu-ls.desktop.session";

type UserSummary = {
  id: number;
  username: string;
  full_name: string | null;
  role: UserRole;
  department: string | null;
  is_active: boolean;
  created_at: string;
};

type CourseSummary = {
  id: number;
  code: string;
  title: string;
  department: string | null;
  semester: number;
  status: string;
  lecturer_username: string;
};

type EnrollmentRequestSummary = {
  id: number;
  course_id: number;
  course_code: string;
  student_username: string;
  status: string;
  created_at: string;
};

type StudentDashboardCourse = {
  course_id: number;
  course_code: string;
  course_title: string;
  semester: number;
  status: string;
  attendance_percent: number;
  internal_marks: number | null;
  external_marks: number | null;
  lecturer_decision: string | null;
};

type StudentDashboard = {
  username: string;
  current_semester: number;
  courses: StudentDashboardCourse[];
};

type CredentialRow = {
  username: string;
  password: string;
  full_name?: string | null;
};

type SyncProcessResult = {
  mode: string;
  queued: number;
  pushed: number;
  failed: number;
  pulled: number;
  update_available: boolean;
  notifications_count: number;
};

type BulkJobStatusPayload = {
  status: "queued" | "running" | "completed" | "failed" | "not_found" | string;
  created: CredentialRow[];
  error: string | null;
};

type DepartmentAdminBulkDefaults = {
  college_code: string;
  department_code: string;
  lecturer_prefix: string;
  student_prefix: string;
};

type LoginMode = "student" | "admin" | "lecturer" | "platform_admin";

type StoredSessionPayload = {
  token: string;
  loginMode: LoginMode;
  user: UserSummary;
  savedAt: string;
};

type AppUpdateState = {
  currentVersion: string;
  latestVersion: string | null;
  checking: boolean;
  available: boolean;
  downloading: boolean;
  downloaded: boolean;
  downloadProgress: number;
  error: string | null;
};

function readStoredSession(): StoredSessionPayload | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredSessionPayload> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (typeof parsed.token !== "string" || parsed.token.trim() === "") {
      return null;
    }

    if (!parsed.user || typeof parsed.user !== "object") {
      return null;
    }

    return {
      token: parsed.token,
      loginMode: parsed.loginMode === "student" || parsed.loginMode === "admin" || parsed.loginMode === "lecturer" || parsed.loginMode === "platform_admin"
        ? parsed.loginMode
        : "platform_admin",
      user: parsed.user as UserSummary,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function writeStoredSession(payload: StoredSessionPayload | null): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!payload) {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
}

function App() {
  const [booting, setBooting] = React.useState(true);
  const [showSplash, setShowSplash] = React.useState(true);
  const [authView, setAuthView] = React.useState<"home" | "login">("home");
  const [loginMode, setLoginMode] = React.useState<LoginMode>("platform_admin");
  const [username, setUsername] = React.useState("platformadmin");
  const [password, setPassword] = React.useState("platformadmin");
  const [session, setSession] = React.useState<UserSummary | null>(() => readStoredSession()?.user ?? null);
  const sessionTokenRef = React.useRef<string>(readStoredSession()?.token ?? "");
  const [error, setError] = React.useState<string>("");
  const [info, setInfo] = React.useState<string>("");
  const [users, setUsers] = React.useState<UserSummary[]>([]);
  const [courses, setCourses] = React.useState<CourseSummary[]>([]);
  const [catalog, setCatalog] = React.useState<CourseSummary[]>([]);
  const [pendingRequests, setPendingRequests] = React.useState<EnrollmentRequestSummary[]>([]);
  const [studentDashboard, setStudentDashboard] = React.useState<StudentDashboard | null>(null);
  const [syncStats, setSyncStats] = React.useState<[number, number, number]>([0, 0, 0]);

  const [activePanel, setActivePanel] = React.useState<"overview" | "users" | "courses" | "attendance" | "marks" | "bulk">("overview");

  const [newUsername, setNewUsername] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [newRole, setNewRole] = React.useState<UserRole>("super_admin");
  const [newDepartment, setNewDepartment] = React.useState("");
  const [newCollegeName, setNewCollegeName] = React.useState("");
  const [newCollegeIdentificationNumber, setNewCollegeIdentificationNumber] = React.useState("");

  const [updateTargetUsername, setUpdateTargetUsername] = React.useState("");
  const [updatePassword, setUpdatePassword] = React.useState("");
  const [updateDepartment, setUpdateDepartment] = React.useState("");
  const [updateActive, setUpdateActive] = React.useState("true");

  const [deleteLecturerUsername, setDeleteLecturerUsername] = React.useState("");
  const [selectedStudentUsernames, setSelectedStudentUsernames] = React.useState<string[]>([]);

  const [bulkLecturerCount, setBulkLecturerCount] = React.useState("5");
  const [studentYear, setStudentYear] = React.useState("");
  const [studentRangeFrom, setStudentRangeFrom] = React.useState("1");
  const [studentRangeTo, setStudentRangeTo] = React.useState("60");
  const [studentRangePadWidth, setStudentRangePadWidth] = React.useState("3");
  const [bulkDefaults, setBulkDefaults] = React.useState<DepartmentAdminBulkDefaults | null>(null);
  const [createdCredentials, setCreatedCredentials] = React.useState<CredentialRow[]>([]);
  const [excelFileName, setExcelFileName] = React.useState("");
  const [profileFullName, setProfileFullName] = React.useState("");
  const [bulkJobId, setBulkJobId] = React.useState("");
  const [bulkJobStatus, setBulkJobStatus] = React.useState<BulkJobStatusPayload | null>(null);
  const processedBulkJobsRef = React.useRef<Set<string>>(new Set());
  const bulkStartLockRef = React.useRef(false);

  const [courseCode, setCourseCode] = React.useState("CSE101");
  const [courseTitle, setCourseTitle] = React.useState("Algorithms");
  const [courseSemester, setCourseSemester] = React.useState("1");
  const [courseDepartment, setCourseDepartment] = React.useState("CSE");

  const [requestIdInput, setRequestIdInput] = React.useState("");
  const [studentCourseId, setStudentCourseId] = React.useState("");
  const [endCourseId, setEndCourseId] = React.useState("");
  const [ackCourseId, setAckCourseId] = React.useState("");

  const [attendanceCourseId, setAttendanceCourseId] = React.useState("");
  const [attendanceStudentUsername, setAttendanceStudentUsername] = React.useState("");
  const [attendanceDate, setAttendanceDate] = React.useState("2026-04-18");
  const [attendanceStatus, setAttendanceStatus] = React.useState<"P" | "A">("P");

  const [marksCourseId, setMarksCourseId] = React.useState("");
  const [marksStudentUsername, setMarksStudentUsername] = React.useState("");
  const [internalMarks, setInternalMarks] = React.useState("40");
  const [externalMarks, setExternalMarks] = React.useState("40");
  const [lecturerDecision, setLecturerDecision] = React.useState("pass");
  const [promoteStudentUsername, setPromoteStudentUsername] = React.useState("");

  const [exportDept, setExportDept] = React.useState("");
  const [exportSemester, setExportSemester] = React.useState("");
  const [exportCourseId, setExportCourseId] = React.useState("");
  const [exportFormat, setExportFormat] = React.useState<"csv" | "excel">("csv");
  const [exportPath, setExportPath] = React.useState("C:/Users/HP/Desktop/stu-ls-export.csv");

  const [syncInProgress, setSyncInProgress] = React.useState(false);
  const syncInProgressRef = React.useRef(false);
  const [onlineStatus, setOnlineStatus] = React.useState<"online" | "offline" | "checking">("checking");
  const [onlineStatusMessage, setOnlineStatusMessage] = React.useState("Checking online sync connection...");
  const [activeSyncUrl, setActiveSyncUrl] = React.useState(DEFAULT_SYNC_URL);
  const updaterRef = React.useRef<any>(null);
  const [updateState, setUpdateState] = React.useState<AppUpdateState>({
    currentVersion: "0.0.0",
    latestVersion: null,
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    downloadProgress: 0,
    error: null
  });

  const handleCheckForUpdates = React.useCallback(async () => {
    setUpdateState((prev) => ({
      ...prev,
      checking: true,
      error: null,
      downloaded: false
    }));

    try {
      const update = await check();
      updaterRef.current = update;

      if (!update) {
        setUpdateState((prev) => ({
          ...prev,
          checking: false,
          available: false,
          latestVersion: null,
          downloading: false,
          downloadProgress: 0
        }));
        setInfo("You already have the latest version.");
        return;
      }

      setUpdateState((prev) => ({
        ...prev,
        checking: false,
        available: true,
        latestVersion: update.version,
        downloading: false,
        downloadProgress: 0
      }));
      setInfo(`Update available: v${update.version}`);
    } catch (e) {
      updaterRef.current = null;
      setUpdateState((prev) => ({
        ...prev,
        checking: false,
        available: false,
        error: String(e),
        downloading: false,
        downloadProgress: 0
      }));
    }
  }, []);

  const handleInstallUpdate = async () => {
    const update = updaterRef.current;
    if (!update) {
      setError("No update is available to install.");
      return;
    }

    setUpdateState((prev) => ({
      ...prev,
      downloading: true,
      downloaded: false,
      downloadProgress: 0,
      error: null
    }));

    try {
      await update.downloadAndInstall((event: any) => {
        if (event?.event === "Progress") {
          const chunkLength = Number(event?.data?.chunkLength ?? 0);
          const contentLength = Number(event?.data?.contentLength ?? 0);
          if (contentLength > 0 && chunkLength > 0) {
            const next = Math.min(100, Math.round((chunkLength / contentLength) * 100));
            setUpdateState((prev) => ({ ...prev, downloadProgress: Math.max(prev.downloadProgress, next) }));
          }
        }

        if (event?.event === "Finished") {
          setUpdateState((prev) => ({ ...prev, downloadProgress: 100 }));
        }
      });

      setUpdateState((prev) => ({
        ...prev,
        downloading: false,
        downloaded: true,
        available: false,
        downloadProgress: 100
      }));
      setInfo("Update downloaded. Restart the app to apply the new version.");
    } catch (e) {
      setUpdateState((prev) => ({
        ...prev,
        downloading: false,
        downloaded: false,
        error: String(e)
      }));
    }
  };

  const handleRestartForUpdate = async () => {
    try {
      await relaunch();
    } catch (e) {
      setError(`Unable to restart automatically: ${String(e)}`);
    }
  };

  const checkOnlineConnection = React.useCallback(async (serverUrl: string, updateStatus = true): Promise<boolean> => {
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/health`, { method: "GET" });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.ok) {
        if (updateStatus) {
          setOnlineStatus("online");
          setOnlineStatusMessage(`Online sync connected: ${serverUrl}`);
        }
        return true;
      } else {
        if (updateStatus) {
          setOnlineStatus("offline");
          setOnlineStatusMessage("Offline mode: online database is unreachable or not initialized.");
        }
        return false;
      }
    } catch {
      if (updateStatus) {
        setOnlineStatus("offline");
        setOnlineStatusMessage("Offline mode: cannot connect to sync server.");
      }
      return false;
    }
  }, []);

  const resolveAvailableSyncServer = React.useCallback(async (): Promise<string | null> => {
    for (const candidateUrl of SYNC_URL_CANDIDATES) {
      const isOnline = await checkOnlineConnection(candidateUrl, false);
      if (isOnline) {
        setActiveSyncUrl(candidateUrl);
        setOnlineStatus("online");
        setOnlineStatusMessage(`Online sync connected: ${candidateUrl}`);
        return candidateUrl;
      }
    }

    setOnlineStatus("offline");
    setOnlineStatusMessage("Offline mode: cannot connect to configured sync servers.");
    return null;
  }, [checkOnlineConnection]);

  const performAutoSync = React.useCallback(async (actor?: { username: string; role: UserRole }) => {
    if (syncInProgressRef.current) {
      return;
    }

    syncInProgressRef.current = true;
    setSyncInProgress(true);
    try {
      const resolvedServerUrl = await resolveAvailableSyncServer();
      if (!resolvedServerUrl) {
        console.log("[desktop] performAutoSync online status:", false);
        return;
      }
      console.log("[desktop] performAutoSync online status:", true, resolvedServerUrl);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await invoke<SyncProcessResult>("process_outbox_and_sync", {
          serverBaseUrl: resolvedServerUrl,
          authToken: DEFAULT_SYNC_TOKEN.trim() || null,
          batchSize: 200,
          actorUsername: actor?.username ?? null,
          actorRole: actor?.role ?? null,
          dryRun: false
        });
        console.log("[desktop] sync attempt result:", {
          attempt: attempt + 1,
          mode: result.mode,
          queued: result.queued,
          pushed: result.pushed,
          failed: result.failed,
          pulled: result.pulled,
          update_available: result.update_available,
          notifications_count: result.notifications_count
        });

        if (result.mode === "idle" || result.queued === 0) {
          break;
        }

        // Stop looping if server keeps rejecting without making progress.
        if (result.pushed === 0 && result.pulled === 0) {
          break;
        }
      }

      await loadSyncStats();
    } catch {
      // Keep app functional in offline mode; status message already indicates connectivity.
    } finally {
      syncInProgressRef.current = false;
      setSyncInProgress(false);
    }
  }, [resolveAvailableSyncServer]);

  React.useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  React.useEffect(() => {
    if (!info) return;
    const timer = window.setTimeout(() => setInfo(""), 5000);
    return () => window.clearTimeout(timer);
  }, [info]);

  React.useEffect(() => {
    if (booting) {
      setShowSplash(true);
      return;
    }

    const timer = window.setTimeout(() => setShowSplash(false), 1200);
    return () => window.clearTimeout(timer);
  }, [booting]);

  React.useEffect(() => {
    setError("");
    setInfo("");
  }, [session?.username]);

  React.useEffect(() => {
    void (async () => {
      try {
        const version = await getVersion();
        setUpdateState((prev) => ({ ...prev, currentVersion: version }));
      } catch {
        // no-op
      }
    })();
  }, []);

  React.useEffect(() => {
    if (!session) {
      return;
    }

    if (!sessionTokenRef.current) {
      sessionTokenRef.current = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    writeStoredSession({
      token: sessionTokenRef.current,
      loginMode,
      user: session,
      savedAt: new Date().toISOString()
    });
  }, [loginMode, session]);

  const handleLogout = () => {
    setError("");
    setInfo("");
    sessionTokenRef.current = "";
    writeStoredSession(null);
    setSession(null);
    setAuthView("home");
  };

  React.useEffect(() => {
    setProfileFullName(session?.full_name ?? "");
  }, [session?.username, session?.full_name]);

  React.useEffect(() => {
    if (!session || session.role !== "department_admin") {
      setBulkDefaults(null);
      return;
    }

    void (async () => {
      try {
        const defaults = await invoke<DepartmentAdminBulkDefaults>("get_department_admin_bulk_defaults", {
          actorUsername: session.username
        });
        setBulkDefaults(defaults);
      } catch (e) {
        setBulkDefaults(null);
        setError(String(e));
      }
    })();
  }, [session?.username, session?.role]);

  const mergeCredentialsUnique = React.useCallback((incoming: CredentialRow[]) => {
    setCreatedCredentials((prev) => {
      const seen = new Set<string>();
      const merged: CredentialRow[] = [];
      for (const row of [...incoming, ...prev]) {
        const key = row.username.trim().toUpperCase();
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        merged.push(row);
        if (merged.length >= 300) {
          break;
        }
      }
      return merged;
    });
  }, []);

  React.useEffect(() => {
    if (!bulkJobId) {
      return;
    }

    if (processedBulkJobsRef.current.has(bulkJobId)) {
      return;
    }

    const currentJobId = bulkJobId;

    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const status = await invoke<BulkJobStatusPayload>("get_bulk_job_status", {
            jobId: currentJobId
          });
          setBulkJobStatus(status);

          if (status.status === "completed") {
            if (processedBulkJobsRef.current.has(currentJobId)) {
              return;
            }
            processedBulkJobsRef.current.add(currentJobId);
            mergeCredentialsUnique(status.created);
            if (session) {
              await refreshData(session.username, session.role);
            }
            setInfo(`Bulk creation completed. Created ${status.created.length} users.`);
            setBulkJobId("");
          } else if (status.status === "failed" || status.status === "not_found") {
            processedBulkJobsRef.current.add(currentJobId);
            setError(status.error ?? "Bulk creation failed.");
            setBulkJobId("");
          }
        } catch (e) {
          processedBulkJobsRef.current.add(currentJobId);
          setError(String(e));
          setBulkJobId("");
        }
      })();
    }, 800);

    return () => window.clearInterval(timer);
  }, [bulkJobId, mergeCredentialsUnique, session]);

  const handleLogin = async () => {
    setError("");
    setInfo("");
    if (!username.trim() || !password.trim()) {
      setError("Username and password are required.");
      return;
    }
    try {
      const commandByMode: Record<LoginMode, string> = {
        student: "login_student",
        admin: "login_admin",
        lecturer: "login_lecturer",
        platform_admin: "login_platform_admin"
      };

      const user = await invoke<UserSummary>(commandByMode[loginMode], { username, password });
      const needsInternalPasswordSetup = await invoke<boolean>("is_internal_password_setup_required", {
        username: user.username
      });

      if (needsInternalPasswordSetup) {
        const firstPassword = window.prompt("Set your internal password (minimum 4 characters):");
        if (!firstPassword || !firstPassword.trim()) {
          setError("Internal password setup is required for first login.");
          return;
        }

        const confirmPassword = window.prompt("Confirm your internal password:");
        if (confirmPassword === null) {
          setError("Internal password confirmation is required.");
          return;
        }

        await invoke("set_internal_password", {
          username: user.username,
          internalPassword: firstPassword,
          confirmPassword
        });
        setInfo("Internal password created successfully.");
      }

      sessionTokenRef.current = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      writeStoredSession({
        token: sessionTokenRef.current,
        loginMode,
        user,
        savedAt: new Date().toISOString()
      });

      await invoke("prune_local_data_for_actor", {
        actorUsername: user.username
      });

      setSession(user);
      setAuthView("login");
    } catch (e) {
      setError(String(e));
    }
  };

  const refreshData = async (actorUsername: string, role: UserRole) => {
    await performAutoSync({ username: actorUsername, role });
    await loadSyncStats();
    await loadUsers(actorUsername);
    if (role === "platform_admin" || role === "super_admin" || role === "department_admin") {
      await loadCourses(actorUsername);
    }
    if (role === "lecturer") {
      await loadCourses(actorUsername);
      await loadPendingRequests(actorUsername);
    }
    if (role === "student") {
      await loadMyCourses(actorUsername);
      await loadCatalog(actorUsername);
      await loadStudentDashboard(actorUsername);
    }
  };

  React.useEffect(() => {
    const bootstrap = async () => {
      try {
        void invoke("initialize_system");
        void invoke("seed_platform_admin", {
          username: "platformadmin",
          password: "platformadmin"
        });
        void invoke("seed_full_sync_snapshot");
        void resolveAvailableSyncServer();
        if (session) {
          setAuthView("login");
          void refreshData(session.username, session.role);
        } else {
          void performAutoSync();
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBooting(false);
      }
    };

    void bootstrap();
  }, [performAutoSync, refreshData, resolveAvailableSyncServer, session]);

  const handleManualRefresh = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await refreshData(session.username, session.role);
      setInfo("Dashboard refreshed.");
    } catch (e) {
      setError(String(e));
    }
  };

  const loadUsers = async (actorUsername: string) => {
    try {
      const result = await invoke<UserSummary[]>("list_users", {
        actorUsername,
        roleFilter: null
      });
      setUsers(result);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadCourses = async (actorUsername: string) => {
    try {
      const result = await invoke<CourseSummary[]>("list_courses", {
        actorUsername,
        includeEnded: true
      });
      setCourses(result);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadMyCourses = loadCourses;

  const loadCatalog = async (actorUsername: string) => {
    try {
      const result = await invoke<CourseSummary[]>("list_course_catalog", {
        actorUsername
      });
      setCatalog(result);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadPendingRequests = async (actorUsername: string) => {
    try {
      const result = await invoke<EnrollmentRequestSummary[]>("list_pending_enrollment_requests", {
        actorUsername
      });
      setPendingRequests(result);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadStudentDashboard = async (actorUsername: string) => {
    try {
      const result = await invoke<StudentDashboard>("get_student_dashboard", {
        actorUsername
      });
      setStudentDashboard(result);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadSyncStats = async () => {
    try {
      const result = await invoke<[number, number, number]>("get_sync_stats");
      setSyncStats(result);
    } catch {
      // No-op if backend not available in pure web mode.
    }
  };

  const requestPlatformInternalPassword = (actionLabel: string): string | null | undefined => {
    if (!session || session.role !== "platform_admin") {
      return undefined;
    }

    const confirmed = window.confirm(`Confirm action: ${actionLabel}`);
    if (!confirmed) {
      setInfo("Action cancelled.");
      return null;
    }

    const internalPassword = window.prompt("Enter internal password to continue:");
    if (!internalPassword || !internalPassword.trim()) {
      setError("Internal password is required for this action.");
      return null;
    }

    return internalPassword;
  };

  const handleCreateUser = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      if (session.role !== "super_admin") {
        const needsManualCredentials = !(session.role === "department_admin" && effectiveNewRole === "lecturer");
        if (needsManualCredentials) {
          if (!newUsername.trim()) {
            setError("Username is required.");
            return;
          }
          if (!newPassword.trim()) {
            setError("Password is required.");
            return;
          }
        }
      }

      if (session.role === "platform_admin" && effectiveNewRole === "super_admin") {
        if (!newCollegeName.trim()) {
          setError("College name is required.");
          return;
        }
        if (!newCollegeIdentificationNumber.trim()) {
          setError("College identification number is required.");
          return;
        }
      }

      const internalPassword = requestPlatformInternalPassword("Create user");
      if (internalPassword === null) {
        return;
      }

      const resolvedServerUrl = await resolveAvailableSyncServer();

      if (session.role === "department_admin" && effectiveNewRole === "lecturer") {
        const credential = await invoke<CredentialRow>("create_lecturer_with_unique_number", {
          actorUsername: session.username,
          syncServerUrl: resolvedServerUrl,
          syncToken: DEFAULT_SYNC_TOKEN
        });
        setCreatedCredentials((prev) => [credential, ...prev].slice(0, 100));
        setInfo(`Lecturer created. Username: ${credential.username}, Password: ${credential.password}`);
        await refreshData(session.username, session.role);
        return;
      }

      if (session.role === "super_admin" && effectiveNewRole === "department_admin") {
        const credential = await invoke<CredentialRow>("create_department_admin_with_unique_number", {
          actorUsername: session.username,
          department: newDepartment,
          syncServerUrl: resolvedServerUrl,
          syncToken: DEFAULT_SYNC_TOKEN
        });
        setCreatedCredentials((prev) => [credential, ...prev].slice(0, 25));
        setNewDepartment("");
        setInfo(`Department admin created. Username: ${credential.username}, Password: ${credential.password}`);
        await refreshData(session.username, session.role);
        return;
      }

      await invoke("create_user", {
        actorUsername: session.username,
        username: newUsername,
        password: newPassword,
        role: effectiveNewRole,
        department: newDepartment.trim() || null,
        fullName: null,
        collegeName:
          session.role === "platform_admin" && effectiveNewRole === "super_admin"
            ? newCollegeName.trim() || null
            : null,
        collegeIdentificationNumber:
          session.role === "platform_admin" && effectiveNewRole === "super_admin"
            ? newCollegeIdentificationNumber.trim() || null
            : null,
        internalPassword,
        syncServerUrl: resolvedServerUrl,
        syncToken: DEFAULT_SYNC_TOKEN
      });
      console.log("[desktop] create_user success:", {
        actorUsername: session.username,
        username: newUsername,
        role: effectiveNewRole,
        department: newDepartment.trim() || null
      });
      setNewUsername("");
      setNewPassword("");
      setNewDepartment("");
      setNewCollegeName("");
      setNewCollegeIdentificationNumber("");
      setInfo("User created successfully.");
      await refreshData(session.username, session.role);
    } catch (e) {
      console.error("[desktop] create_user failed:", e);
      setError(String(e));
    }
  };

  const handleUpdateUser = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      const internalPassword = requestPlatformInternalPassword("Update user");
      if (internalPassword === null) {
        return;
      }

      await invoke("update_user", {
        actorUsername: session.username,
        targetUsername: updateTargetUsername,
        newPassword: updatePassword.trim() ? updatePassword : null,
        newDepartment: updateDepartment.trim() ? updateDepartment : null,
        isActive: updateActive === "true",
        internalPassword
      });
      setInfo("User updated successfully.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteUser = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      const internalPassword = requestPlatformInternalPassword("Delete user");
      if (internalPassword === null) {
        return;
      }

      await invoke("delete_user", {
        actorUsername: session.username,
        targetUsername: updateTargetUsername,
        internalPassword
      });
      setInfo("User deactivated successfully.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteLecturer = async () => {
    if (!session) return;
    if (!deleteLecturerUsername.trim()) {
      setError("Please enter lecturer username to delete.");
      return;
    }
    setError("");
    setInfo("");
    try {
      await invoke("delete_user", {
        actorUsername: session.username,
        targetUsername: deleteLecturerUsername
      });
      setInfo(`Lecturer ${deleteLecturerUsername} has been deleted. Syncing to online database...`);
      setDeleteLecturerUsername("");
        await performAutoSync();
        setInfo(`Lecturer ${deleteLecturerUsername} has been deleted and synced to the database.`);
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteUserByUsername = async (targetUsername: string) => {
    if (!session || !targetUsername.trim()) return;
    setError("");
    setInfo("");
    try {
      const internalPassword = requestPlatformInternalPassword("Delete user");
      if (internalPassword === null) {
        return;
      }

      await invoke("delete_user", {
        actorUsername: session.username,
        targetUsername,
        internalPassword
      });
      setSelectedStudentUsernames((prev) => prev.filter((username) => username !== targetUsername));
      setInfo(`${targetUsername} deleted successfully.`);
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleStudentSelection = (targetUsername: string) => {
    setSelectedStudentUsernames((prev) => {
      if (prev.includes(targetUsername)) {
        return prev.filter((username) => username !== targetUsername);
      }
      return [...prev, targetUsername];
    });
  };

  const handleDeleteSelectedStudents = async () => {
    if (!session) return;
    if (selectedStudentUsernames.length === 0) {
      setError("Select at least one student to delete.");
      return;
    }

    setError("");
    setInfo("");
    try {
      const internalPassword = requestPlatformInternalPassword("Delete selected students");
      if (internalPassword === null) {
        return;
      }

      for (const targetUsername of selectedStudentUsernames) {
        await invoke("delete_user", {
          actorUsername: session.username,
          targetUsername,
          internalPassword
        });
      }

      setSelectedStudentUsernames([]);
      setInfo(`Deleted ${selectedStudentUsernames.length} selected students.`);
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleBulkCreateLecturers = async () => {
    if (!session) return;
    if (bulkStartLockRef.current) {
      return;
    }
    if (bulkJobId) {
      setError("A bulk job is already running. Please wait for it to finish.");
      return;
    }
    setError("");
    setInfo("");
    bulkStartLockRef.current = true;
    try {
      const count = Number(bulkLecturerCount);
      if (!Number.isFinite(count) || count <= 0) {
        setError("Enter a valid lecturer count.");
        return;
      }

      if (!bulkDefaults) {
        setError("Unable to load your branch defaults. Refresh and try again.");
        return;
      }

      const jobId = await invoke<string>("start_bulk_create_lecturers_job", {
        actorUsername: session.username,
        lecturerCount: count
      });
      setBulkJobStatus({ status: "queued", created: [], error: null });
      setBulkJobId(jobId);
      setInfo("Bulk lecturer creation started in background.");
    } catch (e) {
      setError(String(e));
    } finally {
      bulkStartLockRef.current = false;
    }
  };

  const handleBulkCreateStudentsByRange = async () => {
    if (!session) return;
    if (bulkStartLockRef.current) {
      return;
    }
    if (bulkJobId) {
      setError("A bulk job is already running. Please wait for it to finish.");
      return;
    }
    setError("");
    setInfo("");
    bulkStartLockRef.current = true;
    try {
      if (!bulkDefaults) {
        setError("Unable to load your branch defaults. Refresh and try again.");
        return;
      }

      const year = studentYear.trim();
      if (!/^\d{2}(\d{2})?$/.test(year)) {
        setError("Enter student year as YY or YYYY (for example 22 or 2022).");
        return;
      }

      const jobId = await invoke<string>("start_bulk_create_students_by_range_job", {
        actorUsername: session.username,
        studentYear: year,
        fromNumber: Number(studentRangeFrom),
        toNumber: Number(studentRangeTo),
        padWidth: Number(studentRangePadWidth)
      });
      setBulkJobStatus({ status: "queued", created: [], error: null });
      setBulkJobId(jobId);
      setInfo("Bulk student creation (range) started in background.");
    } catch (e) {
      setError(String(e));
    } finally {
      bulkStartLockRef.current = false;
    }
  };

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!session) return;
    if (bulkStartLockRef.current) {
      return;
    }
    if (bulkJobId) {
      setError("A bulk job is already running. Please wait for it to finish.");
      return;
    }
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setInfo("");
    setExcelFileName(file.name);
    bulkStartLockRef.current = true;
    try {
      const buffer = await file.arrayBuffer();
      const usns = extractUsnsFromWorkbookBuffer(buffer);
      if (usns.length === 0) {
        setInfo("No valid USN values found in uploaded file.");
        return;
      }

      const jobId = await invoke<string>("start_bulk_create_students_from_usns_job", {
        actorUsername: session.username,
        usns
      });
      setBulkJobStatus({ status: "queued", created: [], error: null });
      setBulkJobId(jobId);
      setInfo(`Excel parsed ${usns.length} usernames. Background creation started.`);
    } catch (err) {
      setError(String(err));
    } finally {
      bulkStartLockRef.current = false;
    }
  };

  const handleUpdateMyName = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      const updated = await invoke<UserSummary>("update_my_profile_name", {
        actorUsername: session.username,
        fullName: profileFullName
      });
      setSession(updated);
      setInfo("Profile name updated.");
      await refreshData(updated.username, updated.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreateCourse = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("create_course", {
        actorUsername: session.username,
        code: courseCode,
        title: courseTitle,
        department: courseDepartment.trim() || null,
        semester: Number(courseSemester)
      });
      setInfo("Course created successfully.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRequestJoin = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("request_course_join", {
        actorUsername: session.username,
        courseId: Number(studentCourseId)
      });
      setInfo("Join request submitted.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRequestDecision = async (approve: boolean) => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("handle_enrollment_request", {
        actorUsername: session.username,
        requestId: Number(requestIdInput),
        approve
      });
      setInfo(`Request ${approve ? "approved" : "rejected"}.`);
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleEndCourse = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("end_course", {
        actorUsername: session.username,
        courseId: Number(endCourseId),
        confirmation: true
      });
      setInfo("Course ended. Students have up to 15 days to acknowledge before auto-removal.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAcknowledgeEndedCourse = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("acknowledge_ended_course", {
        actorUsername: session.username,
        courseId: Number(ackCourseId)
      });
      setInfo("Ended course acknowledged and removed from your active list.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleMarkAttendance = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("mark_attendance_bulk", {
        actorUsername: session.username,
        courseId: Number(attendanceCourseId),
        entries: [
          {
            student_username: attendanceStudentUsername,
            attendance_date: attendanceDate,
            status: attendanceStatus
          }
        ]
      });
      setInfo("Attendance updated.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleInternalMarks = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("upsert_internal_marks", {
        actorUsername: session.username,
        courseId: Number(marksCourseId),
        studentUsername: marksStudentUsername,
        internalMarks: Number(internalMarks)
      });
      setInfo("Internal marks updated.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleExternalMarks = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("submit_external_marks", {
        actorUsername: session.username,
        courseId: Number(marksCourseId),
        externalMarks: Number(externalMarks)
      });
      setInfo("External marks submitted.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDecision = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("decide_student_result", {
        actorUsername: session.username,
        courseId: Number(marksCourseId),
        studentUsername: marksStudentUsername,
        decision: lecturerDecision
      });
      setInfo("Final decision updated.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePromoteOrReset = async (forcePromote: boolean) => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      const promoted = await invoke<boolean>("promote_or_reset_student_semester", {
        actorUsername: session.username,
        studentUsername: promoteStudentUsername,
        forcePromote
      });
      setInfo(promoted ? "Student promoted to next semester." : "Student not promoted; semester data reset.");
      await refreshData(session.username, session.role);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleExport = async () => {
    if (!session) return;
    setError("");
    setInfo("");
    try {
      await invoke("export_course_data", {
        actorUsername: session.username,
        department: exportDept.trim() || null,
        semester: exportSemester.trim() ? Number(exportSemester) : null,
        courseId: exportCourseId.trim() ? Number(exportCourseId) : null,
        format: exportFormat,
        outputPath: exportPath
      });
      setInfo(`Export generated at ${exportPath}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCleanup = async () => {
    setError("");
    setInfo("");
    try {
      const count = await invoke<number>("cleanup_expired_ended_courses");
      setInfo(`Cleanup completed: ${count} memberships auto-removed.`);
      if (session) {
        await refreshData(session.username, session.role);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const isAdmin =
    session?.role === "platform_admin" ||
    session?.role === "super_admin" ||
    session?.role === "department_admin";

  const isLecturer = session?.role === "lecturer";
  const isStudent = session?.role === "student";

  const createRoleOptions: UserRole[] = session?.role === "platform_admin"
    ? ["super_admin"]
    : session?.role === "super_admin"
      ? ["department_admin"]
      : session?.role === "department_admin"
        ? ["lecturer", "student"]
        : [];

  const effectiveNewRole = createRoleOptions.includes(newRole) ? newRole : createRoleOptions[0] ?? "student";
  const bulkJobRunning = bulkJobStatus?.status === "queued" || bulkJobStatus?.status === "running";

  if (showSplash) {
    return (
      <div className="startup-screen" aria-label="STU-LS Desktop loading screen">
        <div className="startup-orb startup-orb-one" />
        <div className="startup-orb startup-orb-two" />
        <div className="startup-orb startup-orb-three" />
        <main className="startup-card">
          <div className="startup-mark" aria-hidden="true">
            <span>SL</span>
          </div>
          <p className="eyebrow">Student Lifecycle Suite</p>
          <h1>STU-LS Desktop</h1>
          <p className="startup-copy">
            A focused academic operations workspace with offline-first sync and a refined desktop experience.
          </p>
          <div className="startup-loader" aria-hidden="true">
            <span />
          </div>
          <p className="startup-note">{booting ? "Preparing local data and sync services..." : "Opening the app..."}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="container">
      <header className="app-hero card home-hero">
        <div>
          <p className="eyebrow">Student Lifecycle Suite</p>
          <h1>STU-LS Desktop</h1>
          <p className="muted home-copy">
            Offline-first student lifecycle platform with synchronized academic workflows for admins, lecturers, and students.
          </p>
        </div>
        <div className="hero-badge">
          <span className="hero-badge-label">Status</span>
          <strong>{onlineStatus === "online" ? "Connected" : onlineStatus === "offline" ? "Offline" : "Checking"}</strong>
        </div>
      </header>
      <p className={onlineStatus === "online" ? "ok" : onlineStatus === "offline" ? "error" : "muted"}>
        {onlineStatusMessage}
      </p>

      {!session ? (
        <>
          {authView === "home" ? (
            <>
              <section className="home-hero card">
                <p className="eyebrow">Student Lifecycle Suite</p>
                <h2>Manage academics from onboarding to graduation</h2>
                <p className="muted home-copy">
                  STU-LS helps institutions manage users, courses, enrollment, attendance, marks, and semester progression.
                  It works offline-first and continuously syncs with your online database whenever network is available.
                </p>
                <div className="row wrap top-gap">
                  <button onClick={() => setAuthView("login")}>Login to Continue</button>
                </div>
              </section>

              <section className="card">
                <h2>About The App</h2>
                <div className="home-grid">
                  <article className="home-tile">
                    <h3>Offline-First Reliability</h3>
                    <p className="muted">
                      All operations are saved locally first, so staff can keep working even during network interruptions.
                    </p>
                  </article>
                  <article className="home-tile">
                    <h3>Role-Based Workflows</h3>
                    <p className="muted">
                      Platform admin, super admin, department admin, lecturer, and student each get focused workflows.
                    </p>
                  </article>
                  <article className="home-tile">
                    <h3>Continuous Data Sync</h3>
                    <p className="muted">
                      Once online, pending local records are pushed to the online database without manual sync commands.
                    </p>
                  </article>
                </div>
              </section>

              <section className="card">
                <h2>What You Can Use It For</h2>
                <ul className="use-list">
                  <li>Create and manage academic users across departments.</li>
                  <li>Handle course creation, joins, approvals, and completion lifecycle.</li>
                  <li>Track attendance, marks, and semester outcomes in one platform.</li>
                  <li>Export structured course data for reporting and compliance.</li>
                </ul>
              </section>
            </>
          ) : (
            <section className="card auth-card">
              <h2>Login</h2>
              <p className="muted">Choose a login type. Credentials are verified in backend against the users table with role checks.</p>
              <div className="row wrap top-gap">
                <select value={loginMode} onChange={(e) => setLoginMode(e.target.value as LoginMode)}>
                  <option value="student">Student Login</option>
                  <option value="admin">Admin Login</option>
                  <option value="lecturer">Lecturer Login</option>
                  <option value="platform_admin">Platform Admin Login</option>
                </select>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username"
                />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  type="password"
                />
                <button onClick={handleLogin}>Sign in</button>
                <button className="ghost-btn" onClick={() => setAuthView("home")}>Back to Home</button>
              </div>
              <p className="muted top-gap">Default seed: platformadmin / platformadmin</p>
            </section>
          )}
        </>
      ) : (
        <>
          <section className="card">
            <h2>Session</h2>
            <p>
              Signed in as <strong>{session.username}</strong> ({session.role})
            </p>
            <p className="muted">Name: {session.full_name ?? "Not set"}</p>
            <div className="row wrap">
              <button onClick={handleLogout}>Logout</button>
              <button onClick={handleManualRefresh}>Refresh data</button>
            </div>
            <p className="muted">
              Sync queue status: pending {syncStats[0]}, sent {syncStats[1]}, failed {syncStats[2]}
            </p>
            {syncInProgress ? <p className="muted">Syncing changes...</p> : null}

            <div className="top-gap">
              <h3>App Updates</h3>
              <p className="muted">
                Current version: v{updateState.currentVersion}
                {updateState.latestVersion ? ` | Latest: v${updateState.latestVersion}` : ""}
              </p>
              <div className="row wrap">
                <button onClick={handleCheckForUpdates} disabled={updateState.checking || updateState.downloading}>
                  {updateState.checking ? "Checking..." : "Check for Updates"}
                </button>
                {updateState.available ? (
                  <button onClick={handleInstallUpdate} disabled={updateState.downloading}>
                    {updateState.downloading ? "Downloading Update..." : "Download and Install"}
                  </button>
                ) : null}
                {updateState.downloaded ? (
                  <button onClick={handleRestartForUpdate}>Restart to Apply Update</button>
                ) : null}
              </div>
              {updateState.downloading ? (
                <div className="progress-track top-gap" aria-label="Update download progress">
                  <div className="progress-fill" style={{ width: `${updateState.downloadProgress}%` }} />
                </div>
              ) : null}
              {updateState.error ? <p className="error top-gap">{updateState.error}</p> : null}
            </div>
          </section>

          <section className="card">
            <h2>Panels</h2>
            <div className="row wrap">
              <button onClick={() => setActivePanel("overview")}>Overview</button>
              <button onClick={() => setActivePanel("users")}>Users</button>
              {session.role === "department_admin" ? <button onClick={() => setActivePanel("bulk")}>Bulk</button> : null}
              <button onClick={() => setActivePanel("courses")}>Courses</button>
              <button onClick={() => setActivePanel("attendance")}>Attendance</button>
              <button onClick={() => setActivePanel("marks")}>Marks & Semester</button>
            </div>
          </section>

          {bulkJobId ? (
            <section className="card">
              <h2>Background Bulk Job</h2>
              <div className="row wrap">
                <span className={bulkJobRunning ? "spinner" : ""} />
                <p className="muted">
                  Job {bulkJobId}: {bulkJobStatus?.status ?? "queued"}
                </p>
              </div>
              <p className="muted">You can continue using other panels while bulk creation runs.</p>
            </section>
          ) : null}

          {activePanel === "overview" && (
            <section className="card">
              <h2>Overview</h2>
              <p className="muted">Current role: {session.role}</p>
              <div className="row wrap top-gap">
                <label className="field">
                  <span>Profile Name</span>
                  <input
                    value={profileFullName}
                    onChange={(e) => setProfileFullName(e.target.value)}
                    placeholder="Enter your full name"
                  />
                </label>
                <button onClick={handleUpdateMyName}>Save Profile Name</button>
              </div>
              {isStudent && studentDashboard ? (
                <>
                  <p>
                    Current semester: <strong>{studentDashboard.current_semester}</strong>
                  </p>
                  <p>Current/ended enrolled courses: {studentDashboard.courses.length}</p>
                </>
              ) : null}
              {!isStudent ? <p>Total visible courses: {courses.length}</p> : null}
            </section>
          )}

          {activePanel === "users" && (
            <>
              {isAdmin ? (
                <>
                  <section className="card">
                    <h2>Create User</h2>
                    <div className="row wrap">
                      {session.role !== "super_admin" && !(session.role === "department_admin" && effectiveNewRole === "lecturer") ? (
                        <>
                          <label className="field">
                            <span>Username <strong className="required-marker">*</strong></span>
                            <input
                              value={newUsername}
                              onChange={(e) => setNewUsername(e.target.value)}
                              placeholder="New username"
                              required
                            />
                          </label>
                          <label className="field">
                            <span>Password <strong className="required-marker">*</strong></span>
                            <input
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              placeholder="New password"
                              type="password"
                              required
                            />
                          </label>
                        </>
                      ) : null}
                      <label className="field">
                        <span>Role <strong className="required-marker">*</strong></span>
                        <select value={effectiveNewRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
                          {createRoleOptions.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                      </label>
                      {session.role !== "department_admin" ? (
                        <label className="field">
                          <span>Department</span>
                          <input
                            value={newDepartment}
                            onChange={(e) => setNewDepartment(e.target.value)}
                            placeholder="Department (optional)"
                          />
                        </label>
                      ) : null}
                      {session.role === "platform_admin" && effectiveNewRole === "super_admin" ? (
                        <>
                          <label className="field">
                            <span>College Name <strong className="required-marker">*</strong></span>
                            <input
                              value={newCollegeName}
                              onChange={(e) => setNewCollegeName(e.target.value)}
                              placeholder="College name"
                              required
                            />
                          </label>
                          <label className="field">
                            <span>College Identification Number <strong className="required-marker">*</strong></span>
                            <input
                              value={newCollegeIdentificationNumber}
                              onChange={(e) => setNewCollegeIdentificationNumber(e.target.value)}
                              placeholder="College identification number"
                              required
                            />
                          </label>
                        </>
                      ) : null}
                      <button onClick={handleCreateUser}>
                        {session.role === "super_admin" ? "Create Dept Admin (Auto ID)" : "Create"}
                      </button>
                    </div>
                    <p className="muted top-gap">Fields marked with * are required.</p>
                    {session.role === "super_admin" ? (
                      <p className="muted top-gap">
                        Department admin credentials are auto-generated using the unique format: COLLEGE + DEPARTMENT + AD + 3 digits.
                      </p>
                    ) : null}
                  </section>

                  {session.role === "super_admin" && createdCredentials.length > 0 ? (
                    <section className="card">
                      <h2>Generated Department Admin Credentials</h2>
                      <table>
                        <thead>
                          <tr>
                            <th>Username</th>
                            <th>Password</th>
                          </tr>
                        </thead>
                        <tbody>
                          {createdCredentials.map((row) => (
                            <tr key={row.username}>
                              <td>{row.username}</td>
                              <td>{row.password}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>
                  ) : null}

                  <section className="card">
                    <h2>Update / Deactivate User</h2>
                    <div className="row wrap">
                      <input
                        value={updateTargetUsername}
                        onChange={(e) => setUpdateTargetUsername(e.target.value)}
                        placeholder="Target username"
                      />
                      <input
                        value={updatePassword}
                        onChange={(e) => setUpdatePassword(e.target.value)}
                        placeholder="New password (optional)"
                        type="password"
                      />
                      {session.role !== "department_admin" ? (
                        <input
                          value={updateDepartment}
                          onChange={(e) => setUpdateDepartment(e.target.value)}
                          placeholder="New department (optional)"
                        />
                      ) : null}
                      <select value={updateActive} onChange={(e) => setUpdateActive(e.target.value)}>
                        <option value="true">active</option>
                        <option value="false">inactive</option>
                      </select>
                      <button onClick={handleUpdateUser}>Update</button>
                      <button onClick={handleDeleteUser}>Deactivate</button>
                    </div>
                  </section>
                </>
              ) : null}

              {(session.role === "super_admin" || session.role === "department_admin") ? (
                <section className="card">
                  <h2>Delete Lecturer</h2>
                  <p className="muted">Permanently remove a lecturer from the database.</p>
                  <div className="row wrap">
                    <input
                      value={deleteLecturerUsername}
                      onChange={(e) => setDeleteLecturerUsername(e.target.value)}
                      placeholder="Lecturer username to delete"
                    />
                    <button onClick={handleDeleteLecturer} className="error-btn">Delete Lecturer</button>
                  </div>
                  <div className="top-gap">
                    <p className="muted">Available Lecturers:</p>
                    {users.filter((u) => u.role === "lecturer").length === 0 ? (
                      <p className="muted">No lecturers found.</p>
                    ) : (
                      <ul>
                        {users
                          .filter((u) => u.role === "lecturer")
                          .map((u) => (
                            <li key={u.id}>{u.username} - {u.full_name || "Name not set"} ({u.department || "No Dept"})</li>
                          ))}
                      </ul>
                    )}
                  </div>
                </section>
              ) : null}

              <section className="card">
                <h2>Users</h2>
                  {users.some((u) => u.role === "student") ? (
                    <div className="row wrap top-gap">
                      <button
                        onClick={handleDeleteSelectedStudents}
                        disabled={selectedStudentUsernames.length === 0}
                        className="error-btn"
                      >
                        Delete Selected Students ({selectedStudentUsernames.length})
                      </button>
                    </div>
                  ) : null}
                <table>
                  <thead>
                    <tr>
                        <th>Select</th>
                      <th>ID</th>
                      <th>Username</th>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Department</th>
                      <th>Status</th>
                        <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                          <td>
                            {u.role === "student" ? (
                              <input
                                type="checkbox"
                                checked={selectedStudentUsernames.includes(u.username)}
                                onChange={() => toggleStudentSelection(u.username)}
                              />
                            ) : null}
                          </td>
                        <td>{u.id}</td>
                        <td>{u.username}</td>
                        <td>{u.full_name ?? "-"}</td>
                        <td>{u.role}</td>
                        <td>{u.department ?? "-"}</td>
                        <td>{u.is_active ? "active" : "inactive"}</td>
                          <td>
                            {u.role === "student" ? (
                              <button className="error-btn" onClick={() => void handleDeleteUserByUsername(u.username)}>
                                Delete
                              </button>
                            ) : (
                              "-"
                            )}
                          </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}

          {session.role === "department_admin" && activePanel === "bulk" && (
            <section className="card">
              <h2>Bulk Creation</h2>
              {bulkDefaults ? (
                <p className="muted">
                  Branch defaults: college {bulkDefaults.college_code}, department {bulkDefaults.department_code}, lecturer prefix {bulkDefaults.lecturer_prefix}, student prefix {bulkDefaults.student_prefix}
                </p>
              ) : (
                <p className="muted">Loading your branch defaults...</p>
              )}

              <div className="row wrap">
                <input
                  value={bulkLecturerCount}
                  onChange={(e) => setBulkLecturerCount(e.target.value)}
                  placeholder="How many lecturers to create"
                />
                <button onClick={handleBulkCreateLecturers}>Create Lecturers</button>
              </div>

              <div className="row wrap top-gap">
                <input
                  value={studentYear}
                  onChange={(e) => setStudentYear(e.target.value.replace(/\D/g, ""))}
                  placeholder="Student year (YY or YYYY)"
                  inputMode="numeric"
                />
                <input
                  value={bulkDefaults ? `${bulkDefaults.college_code}${studentYear.trim() || "YY"}${bulkDefaults.department_code}` : ""}
                  readOnly
                  placeholder="Student prefix"
                />
                <input
                  value={studentRangeFrom}
                  onChange={(e) => setStudentRangeFrom(e.target.value)}
                  placeholder="From number"
                  inputMode="numeric"
                />
                <input
                  value={studentRangeTo}
                  onChange={(e) => setStudentRangeTo(e.target.value)}
                  placeholder="To number"
                  inputMode="numeric"
                />
                <input
                  value={studentRangePadWidth}
                  onChange={(e) => setStudentRangePadWidth(e.target.value)}
                  placeholder="Pad width (e.g. 3)"
                  inputMode="numeric"
                />
                <button onClick={handleBulkCreateStudentsByRange}>Create Students by Range</button>
              </div>

              <div className="row wrap top-gap">
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} />
                <span className="muted">{excelFileName ? `Selected: ${excelFileName}` : "Upload Excel/CSV for student usernames"}</span>
              </div>

              {createdCredentials.length > 0 ? (
                <table className="top-gap">
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Password</th>
                      <th>Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {createdCredentials.map((row) => (
                      <tr key={row.username}>
                        <td>{row.username}</td>
                        <td>{row.password}</td>
                        <td>{row.full_name ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          )}

          {(isLecturer || isStudent || isAdmin) && activePanel === "courses" && (
            <section className="card">
              <h2>Courses</h2>

              {isLecturer ? (
                <>
                  <div className="row wrap">
                    <input value={courseCode} onChange={(e) => setCourseCode(e.target.value)} placeholder="Course code" />
                    <input value={courseTitle} onChange={(e) => setCourseTitle(e.target.value)} placeholder="Course title" />
                    <input
                      value={courseDepartment}
                      onChange={(e) => setCourseDepartment(e.target.value)}
                      placeholder="Department"
                    />
                    <input
                      value={courseSemester}
                      onChange={(e) => setCourseSemester(e.target.value)}
                      placeholder="Semester"
                    />
                    <button onClick={handleCreateCourse}>Create Course</button>
                  </div>

                  <div className="row wrap top-gap">
                    <input
                      value={requestIdInput}
                      onChange={(e) => setRequestIdInput(e.target.value)}
                      placeholder="Request ID"
                    />
                    <button onClick={() => handleRequestDecision(true)}>Approve Request</button>
                    <button onClick={() => handleRequestDecision(false)}>Reject Request</button>
                    <input value={endCourseId} onChange={(e) => setEndCourseId(e.target.value)} placeholder="Course ID to end" />
                    <button onClick={handleEndCourse}>End Course</button>
                  </div>

                  {pendingRequests.length > 0 ? (
                    <table className="top-gap">
                      <thead>
                        <tr>
                          <th>Request ID</th>
                          <th>Course</th>
                          <th>Student</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingRequests.map((r) => (
                          <tr key={r.id}>
                            <td>{r.id}</td>
                            <td>{r.course_code}</td>
                            <td>{r.student_username}</td>
                            <td>{r.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </>
              ) : null}

              {isStudent ? (
                <>
                  <div className="row wrap">
                    <input
                      value={studentCourseId}
                      onChange={(e) => setStudentCourseId(e.target.value)}
                      placeholder="Course ID to join"
                    />
                    <button onClick={handleRequestJoin}>Request Join</button>
                    <input
                      value={ackCourseId}
                      onChange={(e) => setAckCourseId(e.target.value)}
                      placeholder="Ended Course ID"
                    />
                    <button onClick={handleAcknowledgeEndedCourse}>Acknowledge Ended Course</button>
                  </div>

                  <h3>Course Catalog</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Code</th>
                        <th>Title</th>
                        <th>Semester</th>
                        <th>Lecturer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.map((c) => (
                        <tr key={c.id}>
                          <td>{c.id}</td>
                          <td>{c.code}</td>
                          <td>{c.title}</td>
                          <td>{c.semester}</td>
                          <td>{c.lecturer_username}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}

              <h3>Visible Courses</h3>
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Code</th>
                    <th>Title</th>
                    <th>Semester</th>
                    <th>Status</th>
                    <th>Department</th>
                  </tr>
                </thead>
                <tbody>
                  {courses.map((c) => (
                    <tr key={c.id}>
                      <td>{c.id}</td>
                      <td>{c.code}</td>
                      <td>{c.title}</td>
                      <td>{c.semester}</td>
                      <td>{c.status === "ended" ? "ending_for_student" : c.status}</td>
                      <td>{c.department ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {isLecturer && activePanel === "attendance" && (
            <section className="card">
              <h2>Attendance</h2>
              <div className="row wrap">
                <input
                  value={attendanceCourseId}
                  onChange={(e) => setAttendanceCourseId(e.target.value)}
                  placeholder="Course ID"
                />
                <input
                  value={attendanceStudentUsername}
                  onChange={(e) => setAttendanceStudentUsername(e.target.value)}
                  placeholder="Student username"
                />
                <input value={attendanceDate} onChange={(e) => setAttendanceDate(e.target.value)} placeholder="YYYY-MM-DD" />
                <select value={attendanceStatus} onChange={(e) => setAttendanceStatus(e.target.value as "P" | "A")}>
                  <option value="P">P</option>
                  <option value="A">A</option>
                </select>
                <button onClick={handleMarkAttendance}>Mark Attendance</button>
              </div>
            </section>
          )}

          {(isLecturer || isStudent || isAdmin) && activePanel === "marks" && (
            <section className="card">
              <h2>Marks & Semester</h2>

              {(isLecturer || isStudent) && (
                <div className="row wrap">
                  <input value={marksCourseId} onChange={(e) => setMarksCourseId(e.target.value)} placeholder="Course ID" />
                  {isLecturer ? (
                    <>
                      <input
                        value={marksStudentUsername}
                        onChange={(e) => setMarksStudentUsername(e.target.value)}
                        placeholder="Student username"
                      />
                      <input
                        value={internalMarks}
                        onChange={(e) => setInternalMarks(e.target.value)}
                        placeholder="Internal (0-50)"
                      />
                      <button onClick={handleInternalMarks}>Save Internal Marks</button>
                      <select value={lecturerDecision} onChange={(e) => setLecturerDecision(e.target.value)}>
                        <option value="pass">pass</option>
                        <option value="fail">fail</option>
                        <option value="override_pass">override_pass</option>
                      </select>
                      <button onClick={handleDecision}>Save Final Decision</button>
                    </>
                  ) : null}

                  {isStudent ? (
                    <>
                      <input
                        value={externalMarks}
                        onChange={(e) => setExternalMarks(e.target.value)}
                        placeholder="External (0-50)"
                      />
                      <button onClick={handleExternalMarks}>Submit External Marks</button>
                    </>
                  ) : null}
                </div>
              )}

              {(isLecturer || session.role === "department_admin") && (
                <div className="row wrap top-gap">
                  <input
                    value={promoteStudentUsername}
                    onChange={(e) => setPromoteStudentUsername(e.target.value)}
                    placeholder="Student username"
                  />
                  <button onClick={() => handlePromoteOrReset(false)}>Evaluate and Promote/Reset</button>
                  <button onClick={() => handlePromoteOrReset(true)}>Force Promote (Re-exam bypass)</button>
                </div>
              )}

              {(isLecturer || isAdmin) && (
                <div className="row wrap top-gap">
                  <input value={exportDept} onChange={(e) => setExportDept(e.target.value)} placeholder="Department (optional)" />
                  <input
                    value={exportSemester}
                    onChange={(e) => setExportSemester(e.target.value)}
                    placeholder="Semester (optional)"
                  />
                  <input
                    value={exportCourseId}
                    onChange={(e) => setExportCourseId(e.target.value)}
                    placeholder="Course ID (optional)"
                  />
                  <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as "csv" | "excel")}>
                    <option value="csv">CSV</option>
                    <option value="excel">Excel</option>
                  </select>
                  <input value={exportPath} onChange={(e) => setExportPath(e.target.value)} placeholder="Output path" />
                  <button onClick={handleExport}>Export</button>
                </div>
              )}

              {isStudent && studentDashboard ? (
                <table className="top-gap">
                  <thead>
                    <tr>
                      <th>Course</th>
                      <th>Status</th>
                      <th>Attendance %</th>
                      <th>Internal</th>
                      <th>External</th>
                      <th>Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentDashboard.courses.map((c) => (
                      <tr key={c.course_id}>
                        <td>{c.course_code}</td>
                        <td>{c.status === "ended" ? "ending" : c.status}</td>
                        <td>{c.attendance_percent}</td>
                        <td>{c.internal_marks ?? "-"}</td>
                        <td>{c.external_marks ?? "-"}</td>
                        <td>{c.lecturer_decision ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          )}
        </>
      )}

      {error ? <p className="error">{error}</p> : null}
      {info ? <p className="ok">{info}</p> : null}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
