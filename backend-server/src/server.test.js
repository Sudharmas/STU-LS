import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./server.js";

describe("backend server", () => {
  it("returns health from store", async () => {
    const app = createApp({
      getStorageHealth: vi.fn().mockResolvedValue({ ok: true, mode: "postgres" }),
      processBridgePayload: vi.fn(),
      getUserBootstrapByUsername: vi.fn()
    });

    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.service).toBe("stu-ls-backend-server");
  });

  it("validates sync payload", async () => {
    const app = createApp({
      getStorageHealth: vi.fn().mockResolvedValue({ ok: true, mode: "postgres" }),
      processBridgePayload: vi.fn(),
      getUserBootstrapByUsername: vi.fn()
    });

    const response = await request(app).post("/sync/bridge").send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("client_id");
  });

  it("processes sync payload", async () => {
    const processBridgePayload = vi.fn().mockResolvedValue({
      accepted_outbox_ids: [1],
      rejected: [],
      pull_changes: [],
      update_available: false,
      notifications: []
    });

    const app = createApp({
      getStorageHealth: vi.fn().mockResolvedValue({ ok: true, mode: "postgres" }),
      processBridgePayload,
      getUserBootstrapByUsername: vi.fn()
    });

    const response = await request(app)
      .post("/sync/bridge")
      .send({ client_id: "desktop-client", records: [] });

    expect(response.status).toBe(200);
    expect(response.body.accepted_outbox_ids).toEqual([1]);
    expect(processBridgePayload).toHaveBeenCalledTimes(1);
  });

  it("returns bootstrap user when found", async () => {
    const getUserBootstrapByUsername = vi.fn().mockResolvedValue({ username: "PLATFORMADMIN", role: "platform_admin" });
    const app = createApp({
      getStorageHealth: vi.fn().mockResolvedValue({ ok: true, mode: "postgres" }),
      processBridgePayload: vi.fn(),
      getUserBootstrapByUsername
    });

    const response = await request(app).post("/auth/user-bootstrap").send({ username: "platformadmin" });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.user.username).toBe("PLATFORMADMIN");
    expect(getUserBootstrapByUsername).toHaveBeenCalledWith("platformadmin");
  });

  it("returns visible dashboard users", async () => {
    const getVisibleUsersForViewer = vi.fn().mockResolvedValue([
      { id: 1, username: "PLATFORMADMIN", full_name: null, role: "platform_admin", department: null, is_active: true, created_at: "2026-05-06T00:00:00Z" },
      { id: 2, username: "LECTURER1", full_name: null, role: "lecturer", department: "CSE", is_active: true, created_at: "2026-05-06T00:00:00Z" }
    ]);
    const app = createApp({
      getStorageHealth: vi.fn().mockResolvedValue({ ok: true, mode: "postgres" }),
      processBridgePayload: vi.fn(),
      getUserBootstrapByUsername: vi.fn(),
      getVisibleUsersForViewer
    });

    const response = await request(app).post("/dashboard/users").send({ actor_username: "platformadmin" });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.users).toHaveLength(2);
    expect(getVisibleUsersForViewer).toHaveBeenCalledWith("platformadmin");
  });
});
