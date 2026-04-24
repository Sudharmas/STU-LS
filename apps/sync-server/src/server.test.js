import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";

describe("sync server", () => {
  it("accepts valid sync push payload", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/sync/push")
      .send({
        client_id: "stu-ls-desktop",
        sent_at: new Date().toISOString(),
        records: [
          {
            outbox_id: 101,
            table_name: "users",
            record_id: 17,
            operation: "insert",
            payload: "{\"id\":17}",
            created_at: "2026-04-18 10:00:00",
            retries: 0
          }
        ]
      });

    expect(response.status).toBe(200);
    expect(response.body.accepted_outbox_ids).toContain(101);
  });

  it("rejects malformed payload", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/sync/push")
      .send({ client_id: "", records: "bad" });

    expect(response.status).toBe(400);
  });
});
