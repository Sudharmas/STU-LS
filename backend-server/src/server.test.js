import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./server.js";

describe("backend server", () => {
  it("returns health from store", async () => {
    const app = createApp({
      getStorageHealth: vi.fn().mockResolvedValue({ ok: true, mode: "postgres" }),
      processBridgePayload: vi.fn()
    });

    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.service).toBe("stu-ls-backend-server");
  });

  it("validates sync payload", async () => {
    const app = createApp({
      getStorageHealth: vi.fn().mockResolvedValue({ ok: true, mode: "postgres" }),
      processBridgePayload: vi.fn()
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
      processBridgePayload
    });

    const response = await request(app)
      .post("/sync/bridge")
      .send({ client_id: "desktop-client", records: [] });

    expect(response.status).toBe(200);
    expect(response.body.accepted_outbox_ids).toEqual([1]);
    expect(processBridgePayload).toHaveBeenCalledTimes(1);
  });
});
