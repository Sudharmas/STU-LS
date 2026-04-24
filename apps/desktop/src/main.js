import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { extractUsnsFromWorkbookBuffer } from "./lib/parsers";
import "./styles.css";
const DEFAULT_SYNC_URL = import.meta.env.VITE_SYNC_SERVER_URL ?? "http://localhost:8090";
const SYNC_FALLBACK_URLS = (import.meta.env.VITE_SYNC_FALLBACK_URLS ?? "http://localhost:8090")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
const SYNC_URL_CANDIDATES = Array.from(new Set([DEFAULT_SYNC_URL.trim(), ...SYNC_FALLBACK_URLS]));
const DEFAULT_SYNC_TOKEN = import.meta.env.VITE_SYNC_BEARER_TOKEN ?? "";
const SESSION_STORAGE_KEY = "stu-ls.desktop.session";
function readStoredSession() {
    try {
        const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
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
            user: parsed.user,
            savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString()
        };
    }
    catch {
        return null;
    }
}
function writeStoredSession(payload) {
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
    const [authView, setAuthView] = React.useState("home");
    const [loginMode, setLoginMode] = React.useState("platform_admin");
    const [username, setUsername] = React.useState("platformadmin");
    const [password, setPassword] = React.useState("platformadmin");
    const [session, setSession] = React.useState(() => readStoredSession()?.user ?? null);
    const sessionTokenRef = React.useRef(readStoredSession()?.token ?? "");
    const [error, setError] = React.useState("");
    const [info, setInfo] = React.useState("");
    const [users, setUsers] = React.useState([]);
    const [courses, setCourses] = React.useState([]);
    const [catalog, setCatalog] = React.useState([]);
    const [pendingRequests, setPendingRequests] = React.useState([]);
    const [studentDashboard, setStudentDashboard] = React.useState(null);
    const [syncStats, setSyncStats] = React.useState([0, 0, 0]);
    const [activePanel, setActivePanel] = React.useState("overview");
    const [newUsername, setNewUsername] = React.useState("");
    const [newPassword, setNewPassword] = React.useState("");
    const [newRole, setNewRole] = React.useState("super_admin");
    const [newDepartment, setNewDepartment] = React.useState("");
    const [newCollegeName, setNewCollegeName] = React.useState("");
    const [newCollegeIdentificationNumber, setNewCollegeIdentificationNumber] = React.useState("");
    const [updateTargetUsername, setUpdateTargetUsername] = React.useState("");
    const [updatePassword, setUpdatePassword] = React.useState("");
    const [updateDepartment, setUpdateDepartment] = React.useState("");
    const [updateActive, setUpdateActive] = React.useState("true");
    const [deleteLecturerUsername, setDeleteLecturerUsername] = React.useState("");
    const [selectedStudentUsernames, setSelectedStudentUsernames] = React.useState([]);
    const [bulkLecturerCount, setBulkLecturerCount] = React.useState("5");
    const [studentYear, setStudentYear] = React.useState("");
    const [studentRangeFrom, setStudentRangeFrom] = React.useState("1");
    const [studentRangeTo, setStudentRangeTo] = React.useState("60");
    const [studentRangePadWidth, setStudentRangePadWidth] = React.useState("3");
    const [bulkDefaults, setBulkDefaults] = React.useState(null);
    const [createdCredentials, setCreatedCredentials] = React.useState([]);
    const [excelFileName, setExcelFileName] = React.useState("");
    const [profileFullName, setProfileFullName] = React.useState("");
    const [bulkJobId, setBulkJobId] = React.useState("");
    const [bulkJobStatus, setBulkJobStatus] = React.useState(null);
    const processedBulkJobsRef = React.useRef(new Set());
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
    const [attendanceStatus, setAttendanceStatus] = React.useState("P");
    const [marksCourseId, setMarksCourseId] = React.useState("");
    const [marksStudentUsername, setMarksStudentUsername] = React.useState("");
    const [internalMarks, setInternalMarks] = React.useState("40");
    const [externalMarks, setExternalMarks] = React.useState("40");
    const [lecturerDecision, setLecturerDecision] = React.useState("pass");
    const [promoteStudentUsername, setPromoteStudentUsername] = React.useState("");
    const [exportDept, setExportDept] = React.useState("");
    const [exportSemester, setExportSemester] = React.useState("");
    const [exportCourseId, setExportCourseId] = React.useState("");
    const [exportFormat, setExportFormat] = React.useState("csv");
    const [exportPath, setExportPath] = React.useState("C:/Users/HP/Desktop/stu-ls-export.csv");
    const [syncInProgress, setSyncInProgress] = React.useState(false);
    const syncInProgressRef = React.useRef(false);
    const [onlineStatus, setOnlineStatus] = React.useState("checking");
    const [onlineStatusMessage, setOnlineStatusMessage] = React.useState("Checking online sync connection...");
    const [activeSyncUrl, setActiveSyncUrl] = React.useState(DEFAULT_SYNC_URL);
    const updaterRef = React.useRef(null);
    const [updateState, setUpdateState] = React.useState({
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
        }
        catch (e) {
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
            await update.downloadAndInstall((event) => {
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
        }
        catch (e) {
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
        }
        catch (e) {
            setError(`Unable to restart automatically: ${String(e)}`);
        }
    };
    const checkOnlineConnection = React.useCallback(async (serverUrl, updateStatus = true) => {
        try {
            const response = await fetch(`${serverUrl.replace(/\/$/, "")}/health`, { method: "GET" });
            const body = await response.json().catch(() => ({}));
            if (response.ok && body?.ok) {
                if (updateStatus) {
                    setOnlineStatus("online");
                    setOnlineStatusMessage(`Online sync connected: ${serverUrl}`);
                }
                return true;
            }
            else {
                if (updateStatus) {
                    setOnlineStatus("offline");
                    setOnlineStatusMessage("Offline mode: online database is unreachable or not initialized.");
                }
                return false;
            }
        }
        catch {
            if (updateStatus) {
                setOnlineStatus("offline");
                setOnlineStatusMessage("Offline mode: cannot connect to sync server.");
            }
            return false;
        }
    }, []);
    const resolveAvailableSyncServer = React.useCallback(async () => {
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
    const performAutoSync = React.useCallback(async (actor) => {
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
                const result = await invoke("process_outbox_and_sync", {
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
        }
        catch {
            // Keep app functional in offline mode; status message already indicates connectivity.
        }
        finally {
            syncInProgressRef.current = false;
            setSyncInProgress(false);
        }
    }, [resolveAvailableSyncServer]);
    React.useEffect(() => {
        if (!error)
            return;
        const timer = window.setTimeout(() => setError(""), 5000);
        return () => window.clearTimeout(timer);
    }, [error]);
    React.useEffect(() => {
        if (!info)
            return;
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
            }
            catch {
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
                const defaults = await invoke("get_department_admin_bulk_defaults", {
                    actorUsername: session.username
                });
                setBulkDefaults(defaults);
            }
            catch (e) {
                setBulkDefaults(null);
                setError(String(e));
            }
        })();
    }, [session?.username, session?.role]);
    const mergeCredentialsUnique = React.useCallback((incoming) => {
        setCreatedCredentials((prev) => {
            const seen = new Set();
            const merged = [];
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
                    const status = await invoke("get_bulk_job_status", {
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
                    }
                    else if (status.status === "failed" || status.status === "not_found") {
                        processedBulkJobsRef.current.add(currentJobId);
                        setError(status.error ?? "Bulk creation failed.");
                        setBulkJobId("");
                    }
                }
                catch (e) {
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
            const commandByMode = {
                student: "login_student",
                admin: "login_admin",
                lecturer: "login_lecturer",
                platform_admin: "login_platform_admin"
            };
            const user = await invoke(commandByMode[loginMode], { username, password });
            const needsInternalPasswordSetup = await invoke("is_internal_password_setup_required", {
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const refreshData = async (actorUsername, role) => {
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
                }
                else {
                    void performAutoSync();
                }
            }
            catch (e) {
                setError(String(e));
            }
            finally {
                setBooting(false);
            }
        };
        void bootstrap();
    }, [performAutoSync, refreshData, resolveAvailableSyncServer, session]);
    const handleManualRefresh = async () => {
        if (!session)
            return;
        setError("");
        setInfo("");
        try {
            await refreshData(session.username, session.role);
            setInfo("Dashboard refreshed.");
        }
        catch (e) {
            setError(String(e));
        }
    };
    const loadUsers = async (actorUsername) => {
        try {
            const result = await invoke("list_users", {
                actorUsername,
                roleFilter: null
            });
            setUsers(result);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const loadCourses = async (actorUsername) => {
        try {
            const result = await invoke("list_courses", {
                actorUsername,
                includeEnded: true
            });
            setCourses(result);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const loadMyCourses = loadCourses;
    const loadCatalog = async (actorUsername) => {
        try {
            const result = await invoke("list_course_catalog", {
                actorUsername
            });
            setCatalog(result);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const loadPendingRequests = async (actorUsername) => {
        try {
            const result = await invoke("list_pending_enrollment_requests", {
                actorUsername
            });
            setPendingRequests(result);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const loadStudentDashboard = async (actorUsername) => {
        try {
            const result = await invoke("get_student_dashboard", {
                actorUsername
            });
            setStudentDashboard(result);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const loadSyncStats = async () => {
        try {
            const result = await invoke("get_sync_stats");
            setSyncStats(result);
        }
        catch {
            // No-op if backend not available in pure web mode.
        }
    };
    const requestPlatformInternalPassword = (actionLabel) => {
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
        if (!session)
            return;
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
                const credential = await invoke("create_lecturer_with_unique_number", {
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
                const credential = await invoke("create_department_admin_with_unique_number", {
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
                collegeName: session.role === "platform_admin" && effectiveNewRole === "super_admin"
                    ? newCollegeName.trim() || null
                    : null,
                collegeIdentificationNumber: session.role === "platform_admin" && effectiveNewRole === "super_admin"
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
        }
        catch (e) {
            console.error("[desktop] create_user failed:", e);
            setError(String(e));
        }
    };
    const handleUpdateUser = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleDeleteUser = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleDeleteLecturer = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleDeleteUserByUsername = async (targetUsername) => {
        if (!session || !targetUsername.trim())
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const toggleStudentSelection = (targetUsername) => {
        setSelectedStudentUsernames((prev) => {
            if (prev.includes(targetUsername)) {
                return prev.filter((username) => username !== targetUsername);
            }
            return [...prev, targetUsername];
        });
    };
    const handleDeleteSelectedStudents = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleBulkCreateLecturers = async () => {
        if (!session)
            return;
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
            const jobId = await invoke("start_bulk_create_lecturers_job", {
                actorUsername: session.username,
                lecturerCount: count
            });
            setBulkJobStatus({ status: "queued", created: [], error: null });
            setBulkJobId(jobId);
            setInfo("Bulk lecturer creation started in background.");
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            bulkStartLockRef.current = false;
        }
    };
    const handleBulkCreateStudentsByRange = async () => {
        if (!session)
            return;
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
            const jobId = await invoke("start_bulk_create_students_by_range_job", {
                actorUsername: session.username,
                studentYear: year,
                fromNumber: Number(studentRangeFrom),
                toNumber: Number(studentRangeTo),
                padWidth: Number(studentRangePadWidth)
            });
            setBulkJobStatus({ status: "queued", created: [], error: null });
            setBulkJobId(jobId);
            setInfo("Bulk student creation (range) started in background.");
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            bulkStartLockRef.current = false;
        }
    };
    const handleExcelUpload = async (e) => {
        if (!session)
            return;
        if (bulkStartLockRef.current) {
            return;
        }
        if (bulkJobId) {
            setError("A bulk job is already running. Please wait for it to finish.");
            return;
        }
        const file = e.target.files?.[0];
        if (!file)
            return;
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
            const jobId = await invoke("start_bulk_create_students_from_usns_job", {
                actorUsername: session.username,
                usns
            });
            setBulkJobStatus({ status: "queued", created: [], error: null });
            setBulkJobId(jobId);
            setInfo(`Excel parsed ${usns.length} usernames. Background creation started.`);
        }
        catch (err) {
            setError(String(err));
        }
        finally {
            bulkStartLockRef.current = false;
        }
    };
    const handleUpdateMyName = async () => {
        if (!session)
            return;
        setError("");
        setInfo("");
        try {
            const updated = await invoke("update_my_profile_name", {
                actorUsername: session.username,
                fullName: profileFullName
            });
            setSession(updated);
            setInfo("Profile name updated.");
            await refreshData(updated.username, updated.role);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleCreateCourse = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleRequestJoin = async () => {
        if (!session)
            return;
        setError("");
        setInfo("");
        try {
            await invoke("request_course_join", {
                actorUsername: session.username,
                courseId: Number(studentCourseId)
            });
            setInfo("Join request submitted.");
            await refreshData(session.username, session.role);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleRequestDecision = async (approve) => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleEndCourse = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleAcknowledgeEndedCourse = async () => {
        if (!session)
            return;
        setError("");
        setInfo("");
        try {
            await invoke("acknowledge_ended_course", {
                actorUsername: session.username,
                courseId: Number(ackCourseId)
            });
            setInfo("Ended course acknowledged and removed from your active list.");
            await refreshData(session.username, session.role);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleMarkAttendance = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleInternalMarks = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleExternalMarks = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleDecision = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handlePromoteOrReset = async (forcePromote) => {
        if (!session)
            return;
        setError("");
        setInfo("");
        try {
            const promoted = await invoke("promote_or_reset_student_semester", {
                actorUsername: session.username,
                studentUsername: promoteStudentUsername,
                forcePromote
            });
            setInfo(promoted ? "Student promoted to next semester." : "Student not promoted; semester data reset.");
            await refreshData(session.username, session.role);
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleExport = async () => {
        if (!session)
            return;
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
        }
        catch (e) {
            setError(String(e));
        }
    };
    const handleCleanup = async () => {
        setError("");
        setInfo("");
        try {
            const count = await invoke("cleanup_expired_ended_courses");
            setInfo(`Cleanup completed: ${count} memberships auto-removed.`);
            if (session) {
                await refreshData(session.username, session.role);
            }
        }
        catch (e) {
            setError(String(e));
        }
    };
    const isAdmin = session?.role === "platform_admin" ||
        session?.role === "super_admin" ||
        session?.role === "department_admin";
    const isLecturer = session?.role === "lecturer";
    const isStudent = session?.role === "student";
    const createRoleOptions = session?.role === "platform_admin"
        ? ["super_admin"]
        : session?.role === "super_admin"
            ? ["department_admin"]
            : session?.role === "department_admin"
                ? ["lecturer", "student"]
                : [];
    const effectiveNewRole = createRoleOptions.includes(newRole) ? newRole : createRoleOptions[0] ?? "student";
    const bulkJobRunning = bulkJobStatus?.status === "queued" || bulkJobStatus?.status === "running";
    if (showSplash) {
        return (_jsxs("div", { className: "startup-screen", "aria-label": "STU-LS Desktop loading screen", children: [_jsx("div", { className: "startup-orb startup-orb-one" }), _jsx("div", { className: "startup-orb startup-orb-two" }), _jsx("div", { className: "startup-orb startup-orb-three" }), _jsxs("main", { className: "startup-card", children: [_jsx("div", { className: "startup-mark", "aria-hidden": "true", children: _jsx("span", { children: "SL" }) }), _jsx("p", { className: "eyebrow", children: "Student Lifecycle Suite" }), _jsx("h1", { children: "STU-LS Desktop" }), _jsx("p", { className: "startup-copy", children: "A focused academic operations workspace with offline-first sync and a refined desktop experience." }), _jsx("div", { className: "startup-loader", "aria-hidden": "true", children: _jsx("span", {}) }), _jsx("p", { className: "startup-note", children: booting ? "Preparing local data and sync services..." : "Opening the app..." })] })] }));
    }
    return (_jsx("div", { className: "app-shell", children: _jsxs("div", { className: "container", children: [_jsxs("header", { className: "app-hero card home-hero", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Student Lifecycle Suite" }), _jsx("h1", { children: "STU-LS Desktop" }), _jsx("p", { className: "muted home-copy", children: "Offline-first student lifecycle platform with synchronized academic workflows for admins, lecturers, and students." })] }), _jsxs("div", { className: "hero-badge", children: [_jsx("span", { className: "hero-badge-label", children: "Status" }), _jsx("strong", { children: onlineStatus === "online" ? "Connected" : onlineStatus === "offline" ? "Offline" : "Checking" })] })] }), _jsx("p", { className: onlineStatus === "online" ? "ok" : onlineStatus === "offline" ? "error" : "muted", children: onlineStatusMessage }), !session ? (_jsx(_Fragment, { children: authView === "home" ? (_jsxs(_Fragment, { children: [_jsxs("section", { className: "home-hero card", children: [_jsx("p", { className: "eyebrow", children: "Student Lifecycle Suite" }), _jsx("h2", { children: "Manage academics from onboarding to graduation" }), _jsx("p", { className: "muted home-copy", children: "STU-LS helps institutions manage users, courses, enrollment, attendance, marks, and semester progression. It works offline-first and continuously syncs with your online database whenever network is available." }), _jsx("div", { className: "row wrap top-gap", children: _jsx("button", { onClick: () => setAuthView("login"), children: "Login to Continue" }) })] }), _jsxs("section", { className: "card", children: [_jsx("h2", { children: "About The App" }), _jsxs("div", { className: "home-grid", children: [_jsxs("article", { className: "home-tile", children: [_jsx("h3", { children: "Offline-First Reliability" }), _jsx("p", { className: "muted", children: "All operations are saved locally first, so staff can keep working even during network interruptions." })] }), _jsxs("article", { className: "home-tile", children: [_jsx("h3", { children: "Role-Based Workflows" }), _jsx("p", { className: "muted", children: "Platform admin, super admin, department admin, lecturer, and student each get focused workflows." })] }), _jsxs("article", { className: "home-tile", children: [_jsx("h3", { children: "Continuous Data Sync" }), _jsx("p", { className: "muted", children: "Once online, pending local records are pushed to the online database without manual sync commands." })] })] })] }), _jsxs("section", { className: "card", children: [_jsx("h2", { children: "What You Can Use It For" }), _jsxs("ul", { className: "use-list", children: [_jsx("li", { children: "Create and manage academic users across departments." }), _jsx("li", { children: "Handle course creation, joins, approvals, and completion lifecycle." }), _jsx("li", { children: "Track attendance, marks, and semester outcomes in one platform." }), _jsx("li", { children: "Export structured course data for reporting and compliance." })] })] })] })) : (_jsxs("section", { className: "card auth-card", children: [_jsx("h2", { children: "Login" }), _jsx("p", { className: "muted", children: "Choose a login type. Credentials are verified in backend against the users table with role checks." }), _jsxs("div", { className: "row wrap top-gap", children: [_jsxs("select", { value: loginMode, onChange: (e) => setLoginMode(e.target.value), children: [_jsx("option", { value: "student", children: "Student Login" }), _jsx("option", { value: "admin", children: "Admin Login" }), _jsx("option", { value: "lecturer", children: "Lecturer Login" }), _jsx("option", { value: "platform_admin", children: "Platform Admin Login" })] }), _jsx("input", { value: username, onChange: (e) => setUsername(e.target.value), placeholder: "Username" }), _jsx("input", { value: password, onChange: (e) => setPassword(e.target.value), placeholder: "Password", type: "password" }), _jsx("button", { onClick: handleLogin, children: "Sign in" }), _jsx("button", { className: "ghost-btn", onClick: () => setAuthView("home"), children: "Back to Home" })] }), _jsx("p", { className: "muted top-gap", children: "Default seed: platformadmin / platformadmin" })] })) })) : (_jsxs(_Fragment, { children: [_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Session" }), _jsxs("p", { children: ["Signed in as ", _jsx("strong", { children: session.username }), " (", session.role, ")"] }), _jsxs("p", { className: "muted", children: ["Name: ", session.full_name ?? "Not set"] }), _jsxs("div", { className: "row wrap", children: [_jsx("button", { onClick: handleLogout, children: "Logout" }), _jsx("button", { onClick: handleManualRefresh, children: "Refresh data" })] }), _jsxs("p", { className: "muted", children: ["Sync queue status: pending ", syncStats[0], ", sent ", syncStats[1], ", failed ", syncStats[2]] }), syncInProgress ? _jsx("p", { className: "muted", children: "Syncing changes..." }) : null, _jsxs("div", { className: "top-gap", children: [_jsx("h3", { children: "App Updates" }), _jsxs("p", { className: "muted", children: ["Current version: v", updateState.currentVersion, updateState.latestVersion ? ` | Latest: v${updateState.latestVersion}` : ""] }), _jsxs("div", { className: "row wrap", children: [_jsx("button", { onClick: handleCheckForUpdates, disabled: updateState.checking || updateState.downloading, children: updateState.checking ? "Checking..." : "Check for Updates" }), updateState.available ? (_jsx("button", { onClick: handleInstallUpdate, disabled: updateState.downloading, children: updateState.downloading ? "Downloading Update..." : "Download and Install" })) : null, updateState.downloaded ? (_jsx("button", { onClick: handleRestartForUpdate, children: "Restart to Apply Update" })) : null] }), updateState.downloading ? (_jsx("div", { className: "progress-track top-gap", "aria-label": "Update download progress", children: _jsx("div", { className: "progress-fill", style: { width: `${updateState.downloadProgress}%` } }) })) : null, updateState.error ? _jsx("p", { className: "error top-gap", children: updateState.error }) : null] })] }), _jsxs("section", { className: "card", children: [_jsx("h2", { children: "Panels" }), _jsxs("div", { className: "row wrap", children: [_jsx("button", { onClick: () => setActivePanel("overview"), children: "Overview" }), _jsx("button", { onClick: () => setActivePanel("users"), children: "Users" }), session.role === "department_admin" ? _jsx("button", { onClick: () => setActivePanel("bulk"), children: "Bulk" }) : null, _jsx("button", { onClick: () => setActivePanel("courses"), children: "Courses" }), _jsx("button", { onClick: () => setActivePanel("attendance"), children: "Attendance" }), _jsx("button", { onClick: () => setActivePanel("marks"), children: "Marks & Semester" })] })] }), bulkJobId ? (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Background Bulk Job" }), _jsxs("div", { className: "row wrap", children: [_jsx("span", { className: bulkJobRunning ? "spinner" : "" }), _jsxs("p", { className: "muted", children: ["Job ", bulkJobId, ": ", bulkJobStatus?.status ?? "queued"] })] }), _jsx("p", { className: "muted", children: "You can continue using other panels while bulk creation runs." })] })) : null, activePanel === "overview" && (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Overview" }), _jsxs("p", { className: "muted", children: ["Current role: ", session.role] }), _jsxs("div", { className: "row wrap top-gap", children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "Profile Name" }), _jsx("input", { value: profileFullName, onChange: (e) => setProfileFullName(e.target.value), placeholder: "Enter your full name" })] }), _jsx("button", { onClick: handleUpdateMyName, children: "Save Profile Name" })] }), isStudent && studentDashboard ? (_jsxs(_Fragment, { children: [_jsxs("p", { children: ["Current semester: ", _jsx("strong", { children: studentDashboard.current_semester })] }), _jsxs("p", { children: ["Current/ended enrolled courses: ", studentDashboard.courses.length] })] })) : null, !isStudent ? _jsxs("p", { children: ["Total visible courses: ", courses.length] }) : null] })), activePanel === "users" && (_jsxs(_Fragment, { children: [isAdmin ? (_jsxs(_Fragment, { children: [_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Create User" }), _jsxs("div", { className: "row wrap", children: [session.role !== "super_admin" && !(session.role === "department_admin" && effectiveNewRole === "lecturer") ? (_jsxs(_Fragment, { children: [_jsxs("label", { className: "field", children: [_jsxs("span", { children: ["Username ", _jsx("strong", { className: "required-marker", children: "*" })] }), _jsx("input", { value: newUsername, onChange: (e) => setNewUsername(e.target.value), placeholder: "New username", required: true })] }), _jsxs("label", { className: "field", children: [_jsxs("span", { children: ["Password ", _jsx("strong", { className: "required-marker", children: "*" })] }), _jsx("input", { value: newPassword, onChange: (e) => setNewPassword(e.target.value), placeholder: "New password", type: "password", required: true })] })] })) : null, _jsxs("label", { className: "field", children: [_jsxs("span", { children: ["Role ", _jsx("strong", { className: "required-marker", children: "*" })] }), _jsx("select", { value: effectiveNewRole, onChange: (e) => setNewRole(e.target.value), children: createRoleOptions.map((role) => (_jsx("option", { value: role, children: role }, role))) })] }), session.role !== "department_admin" ? (_jsxs("label", { className: "field", children: [_jsx("span", { children: "Department" }), _jsx("input", { value: newDepartment, onChange: (e) => setNewDepartment(e.target.value), placeholder: "Department (optional)" })] })) : null, session.role === "platform_admin" && effectiveNewRole === "super_admin" ? (_jsxs(_Fragment, { children: [_jsxs("label", { className: "field", children: [_jsxs("span", { children: ["College Name ", _jsx("strong", { className: "required-marker", children: "*" })] }), _jsx("input", { value: newCollegeName, onChange: (e) => setNewCollegeName(e.target.value), placeholder: "College name", required: true })] }), _jsxs("label", { className: "field", children: [_jsxs("span", { children: ["College Identification Number ", _jsx("strong", { className: "required-marker", children: "*" })] }), _jsx("input", { value: newCollegeIdentificationNumber, onChange: (e) => setNewCollegeIdentificationNumber(e.target.value), placeholder: "College identification number", required: true })] })] })) : null, _jsx("button", { onClick: handleCreateUser, children: session.role === "super_admin" ? "Create Dept Admin (Auto ID)" : "Create" })] }), _jsx("p", { className: "muted top-gap", children: "Fields marked with * are required." }), session.role === "super_admin" ? (_jsx("p", { className: "muted top-gap", children: "Department admin credentials are auto-generated using the unique format: COLLEGE + DEPARTMENT + AD + 3 digits." })) : null] }), session.role === "super_admin" && createdCredentials.length > 0 ? (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Generated Department Admin Credentials" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Username" }), _jsx("th", { children: "Password" })] }) }), _jsx("tbody", { children: createdCredentials.map((row) => (_jsxs("tr", { children: [_jsx("td", { children: row.username }), _jsx("td", { children: row.password })] }, row.username))) })] })] })) : null, _jsxs("section", { className: "card", children: [_jsx("h2", { children: "Update / Deactivate User" }), _jsxs("div", { className: "row wrap", children: [_jsx("input", { value: updateTargetUsername, onChange: (e) => setUpdateTargetUsername(e.target.value), placeholder: "Target username" }), _jsx("input", { value: updatePassword, onChange: (e) => setUpdatePassword(e.target.value), placeholder: "New password (optional)", type: "password" }), session.role !== "department_admin" ? (_jsx("input", { value: updateDepartment, onChange: (e) => setUpdateDepartment(e.target.value), placeholder: "New department (optional)" })) : null, _jsxs("select", { value: updateActive, onChange: (e) => setUpdateActive(e.target.value), children: [_jsx("option", { value: "true", children: "active" }), _jsx("option", { value: "false", children: "inactive" })] }), _jsx("button", { onClick: handleUpdateUser, children: "Update" }), _jsx("button", { onClick: handleDeleteUser, children: "Deactivate" })] })] })] })) : null, (session.role === "super_admin" || session.role === "department_admin") ? (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Delete Lecturer" }), _jsx("p", { className: "muted", children: "Permanently remove a lecturer from the database." }), _jsxs("div", { className: "row wrap", children: [_jsx("input", { value: deleteLecturerUsername, onChange: (e) => setDeleteLecturerUsername(e.target.value), placeholder: "Lecturer username to delete" }), _jsx("button", { onClick: handleDeleteLecturer, className: "error-btn", children: "Delete Lecturer" })] }), _jsxs("div", { className: "top-gap", children: [_jsx("p", { className: "muted", children: "Available Lecturers:" }), users.filter((u) => u.role === "lecturer").length === 0 ? (_jsx("p", { className: "muted", children: "No lecturers found." })) : (_jsx("ul", { children: users
                                                        .filter((u) => u.role === "lecturer")
                                                        .map((u) => (_jsxs("li", { children: [u.username, " - ", u.full_name || "Name not set", " (", u.department || "No Dept", ")"] }, u.id))) }))] })] })) : null, _jsxs("section", { className: "card", children: [_jsx("h2", { children: "Users" }), users.some((u) => u.role === "student") ? (_jsx("div", { className: "row wrap top-gap", children: _jsxs("button", { onClick: handleDeleteSelectedStudents, disabled: selectedStudentUsernames.length === 0, className: "error-btn", children: ["Delete Selected Students (", selectedStudentUsernames.length, ")"] }) })) : null, _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Select" }), _jsx("th", { children: "ID" }), _jsx("th", { children: "Username" }), _jsx("th", { children: "Name" }), _jsx("th", { children: "Role" }), _jsx("th", { children: "Department" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Actions" })] }) }), _jsx("tbody", { children: users.map((u) => (_jsxs("tr", { children: [_jsx("td", { children: u.role === "student" ? (_jsx("input", { type: "checkbox", checked: selectedStudentUsernames.includes(u.username), onChange: () => toggleStudentSelection(u.username) })) : null }), _jsx("td", { children: u.id }), _jsx("td", { children: u.username }), _jsx("td", { children: u.full_name ?? "-" }), _jsx("td", { children: u.role }), _jsx("td", { children: u.department ?? "-" }), _jsx("td", { children: u.is_active ? "active" : "inactive" }), _jsx("td", { children: u.role === "student" ? (_jsx("button", { className: "error-btn", onClick: () => void handleDeleteUserByUsername(u.username), children: "Delete" })) : ("-") })] }, u.id))) })] })] })] })), session.role === "department_admin" && activePanel === "bulk" && (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Bulk Creation" }), bulkDefaults ? (_jsxs("p", { className: "muted", children: ["Branch defaults: college ", bulkDefaults.college_code, ", department ", bulkDefaults.department_code, ", lecturer prefix ", bulkDefaults.lecturer_prefix, ", student prefix ", bulkDefaults.student_prefix] })) : (_jsx("p", { className: "muted", children: "Loading your branch defaults..." })), _jsxs("div", { className: "row wrap", children: [_jsx("input", { value: bulkLecturerCount, onChange: (e) => setBulkLecturerCount(e.target.value), placeholder: "How many lecturers to create" }), _jsx("button", { onClick: handleBulkCreateLecturers, children: "Create Lecturers" })] }), _jsxs("div", { className: "row wrap top-gap", children: [_jsx("input", { value: studentYear, onChange: (e) => setStudentYear(e.target.value.replace(/\D/g, "")), placeholder: "Student year (YY or YYYY)", inputMode: "numeric" }), _jsx("input", { value: bulkDefaults ? `${bulkDefaults.college_code}${studentYear.trim() || "YY"}${bulkDefaults.department_code}` : "", readOnly: true, placeholder: "Student prefix" }), _jsx("input", { value: studentRangeFrom, onChange: (e) => setStudentRangeFrom(e.target.value), placeholder: "From number", inputMode: "numeric" }), _jsx("input", { value: studentRangeTo, onChange: (e) => setStudentRangeTo(e.target.value), placeholder: "To number", inputMode: "numeric" }), _jsx("input", { value: studentRangePadWidth, onChange: (e) => setStudentRangePadWidth(e.target.value), placeholder: "Pad width (e.g. 3)", inputMode: "numeric" }), _jsx("button", { onClick: handleBulkCreateStudentsByRange, children: "Create Students by Range" })] }), _jsxs("div", { className: "row wrap top-gap", children: [_jsx("input", { type: "file", accept: ".xlsx,.xls,.csv", onChange: handleExcelUpload }), _jsx("span", { className: "muted", children: excelFileName ? `Selected: ${excelFileName}` : "Upload Excel/CSV for student usernames" })] }), createdCredentials.length > 0 ? (_jsxs("table", { className: "top-gap", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Username" }), _jsx("th", { children: "Password" }), _jsx("th", { children: "Name" })] }) }), _jsx("tbody", { children: createdCredentials.map((row) => (_jsxs("tr", { children: [_jsx("td", { children: row.username }), _jsx("td", { children: row.password }), _jsx("td", { children: row.full_name ?? "-" })] }, row.username))) })] })) : null] })), (isLecturer || isStudent || isAdmin) && activePanel === "courses" && (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Courses" }), isLecturer ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "row wrap", children: [_jsx("input", { value: courseCode, onChange: (e) => setCourseCode(e.target.value), placeholder: "Course code" }), _jsx("input", { value: courseTitle, onChange: (e) => setCourseTitle(e.target.value), placeholder: "Course title" }), _jsx("input", { value: courseDepartment, onChange: (e) => setCourseDepartment(e.target.value), placeholder: "Department" }), _jsx("input", { value: courseSemester, onChange: (e) => setCourseSemester(e.target.value), placeholder: "Semester" }), _jsx("button", { onClick: handleCreateCourse, children: "Create Course" })] }), _jsxs("div", { className: "row wrap top-gap", children: [_jsx("input", { value: requestIdInput, onChange: (e) => setRequestIdInput(e.target.value), placeholder: "Request ID" }), _jsx("button", { onClick: () => handleRequestDecision(true), children: "Approve Request" }), _jsx("button", { onClick: () => handleRequestDecision(false), children: "Reject Request" }), _jsx("input", { value: endCourseId, onChange: (e) => setEndCourseId(e.target.value), placeholder: "Course ID to end" }), _jsx("button", { onClick: handleEndCourse, children: "End Course" })] }), pendingRequests.length > 0 ? (_jsxs("table", { className: "top-gap", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Request ID" }), _jsx("th", { children: "Course" }), _jsx("th", { children: "Student" }), _jsx("th", { children: "Status" })] }) }), _jsx("tbody", { children: pendingRequests.map((r) => (_jsxs("tr", { children: [_jsx("td", { children: r.id }), _jsx("td", { children: r.course_code }), _jsx("td", { children: r.student_username }), _jsx("td", { children: r.status })] }, r.id))) })] })) : null] })) : null, isStudent ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "row wrap", children: [_jsx("input", { value: studentCourseId, onChange: (e) => setStudentCourseId(e.target.value), placeholder: "Course ID to join" }), _jsx("button", { onClick: handleRequestJoin, children: "Request Join" }), _jsx("input", { value: ackCourseId, onChange: (e) => setAckCourseId(e.target.value), placeholder: "Ended Course ID" }), _jsx("button", { onClick: handleAcknowledgeEndedCourse, children: "Acknowledge Ended Course" })] }), _jsx("h3", { children: "Course Catalog" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "ID" }), _jsx("th", { children: "Code" }), _jsx("th", { children: "Title" }), _jsx("th", { children: "Semester" }), _jsx("th", { children: "Lecturer" })] }) }), _jsx("tbody", { children: catalog.map((c) => (_jsxs("tr", { children: [_jsx("td", { children: c.id }), _jsx("td", { children: c.code }), _jsx("td", { children: c.title }), _jsx("td", { children: c.semester }), _jsx("td", { children: c.lecturer_username })] }, c.id))) })] })] })) : null, _jsx("h3", { children: "Visible Courses" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "ID" }), _jsx("th", { children: "Code" }), _jsx("th", { children: "Title" }), _jsx("th", { children: "Semester" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Department" })] }) }), _jsx("tbody", { children: courses.map((c) => (_jsxs("tr", { children: [_jsx("td", { children: c.id }), _jsx("td", { children: c.code }), _jsx("td", { children: c.title }), _jsx("td", { children: c.semester }), _jsx("td", { children: c.status === "ended" ? "ending_for_student" : c.status }), _jsx("td", { children: c.department ?? "-" })] }, c.id))) })] })] })), isLecturer && activePanel === "attendance" && (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Attendance" }), _jsxs("div", { className: "row wrap", children: [_jsx("input", { value: attendanceCourseId, onChange: (e) => setAttendanceCourseId(e.target.value), placeholder: "Course ID" }), _jsx("input", { value: attendanceStudentUsername, onChange: (e) => setAttendanceStudentUsername(e.target.value), placeholder: "Student username" }), _jsx("input", { value: attendanceDate, onChange: (e) => setAttendanceDate(e.target.value), placeholder: "YYYY-MM-DD" }), _jsxs("select", { value: attendanceStatus, onChange: (e) => setAttendanceStatus(e.target.value), children: [_jsx("option", { value: "P", children: "P" }), _jsx("option", { value: "A", children: "A" })] }), _jsx("button", { onClick: handleMarkAttendance, children: "Mark Attendance" })] })] })), (isLecturer || isStudent || isAdmin) && activePanel === "marks" && (_jsxs("section", { className: "card", children: [_jsx("h2", { children: "Marks & Semester" }), (isLecturer || isStudent) && (_jsxs("div", { className: "row wrap", children: [_jsx("input", { value: marksCourseId, onChange: (e) => setMarksCourseId(e.target.value), placeholder: "Course ID" }), isLecturer ? (_jsxs(_Fragment, { children: [_jsx("input", { value: marksStudentUsername, onChange: (e) => setMarksStudentUsername(e.target.value), placeholder: "Student username" }), _jsx("input", { value: internalMarks, onChange: (e) => setInternalMarks(e.target.value), placeholder: "Internal (0-50)" }), _jsx("button", { onClick: handleInternalMarks, children: "Save Internal Marks" }), _jsxs("select", { value: lecturerDecision, onChange: (e) => setLecturerDecision(e.target.value), children: [_jsx("option", { value: "pass", children: "pass" }), _jsx("option", { value: "fail", children: "fail" }), _jsx("option", { value: "override_pass", children: "override_pass" })] }), _jsx("button", { onClick: handleDecision, children: "Save Final Decision" })] })) : null, isStudent ? (_jsxs(_Fragment, { children: [_jsx("input", { value: externalMarks, onChange: (e) => setExternalMarks(e.target.value), placeholder: "External (0-50)" }), _jsx("button", { onClick: handleExternalMarks, children: "Submit External Marks" })] })) : null] })), (isLecturer || session.role === "department_admin") && (_jsxs("div", { className: "row wrap top-gap", children: [_jsx("input", { value: promoteStudentUsername, onChange: (e) => setPromoteStudentUsername(e.target.value), placeholder: "Student username" }), _jsx("button", { onClick: () => handlePromoteOrReset(false), children: "Evaluate and Promote/Reset" }), _jsx("button", { onClick: () => handlePromoteOrReset(true), children: "Force Promote (Re-exam bypass)" })] })), (isLecturer || isAdmin) && (_jsxs("div", { className: "row wrap top-gap", children: [_jsx("input", { value: exportDept, onChange: (e) => setExportDept(e.target.value), placeholder: "Department (optional)" }), _jsx("input", { value: exportSemester, onChange: (e) => setExportSemester(e.target.value), placeholder: "Semester (optional)" }), _jsx("input", { value: exportCourseId, onChange: (e) => setExportCourseId(e.target.value), placeholder: "Course ID (optional)" }), _jsxs("select", { value: exportFormat, onChange: (e) => setExportFormat(e.target.value), children: [_jsx("option", { value: "csv", children: "CSV" }), _jsx("option", { value: "excel", children: "Excel" })] }), _jsx("input", { value: exportPath, onChange: (e) => setExportPath(e.target.value), placeholder: "Output path" }), _jsx("button", { onClick: handleExport, children: "Export" })] })), isStudent && studentDashboard ? (_jsxs("table", { className: "top-gap", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Course" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Attendance %" }), _jsx("th", { children: "Internal" }), _jsx("th", { children: "External" }), _jsx("th", { children: "Decision" })] }) }), _jsx("tbody", { children: studentDashboard.courses.map((c) => (_jsxs("tr", { children: [_jsx("td", { children: c.course_code }), _jsx("td", { children: c.status === "ended" ? "ending" : c.status }), _jsx("td", { children: c.attendance_percent }), _jsx("td", { children: c.internal_marks ?? "-" }), _jsx("td", { children: c.external_marks ?? "-" }), _jsx("td", { children: c.lecturer_decision ?? "-" })] }, c.course_id))) })] })) : null] }))] })), error ? _jsx("p", { className: "error", children: error }) : null, info ? _jsx("p", { className: "ok", children: info }) : null] }) }));
}
ReactDOM.createRoot(document.getElementById("root")).render(_jsx(React.StrictMode, { children: _jsx(App, {}) }));
