import "dotenv/config";
import express from "express";
import cors from "cors";
import { enqueuePullChange, getStateSnapshot, getStorageHealth, processPushPayload } from "./store.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      // eslint-disable-next-line no-console
      console.log(`[sync-server] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
  });

  app.get("/health", (_req, res) => {
    return Promise.resolve(getStorageHealth())
      .then((health) => {
        if (!health.ok) {
          return res.status(503).json({ ok: false, service: "stu-ls-sync-server", ...health });
        }
        return res.json({ ok: true, service: "stu-ls-sync-server", ...health });
      })
      .catch((error) => res.status(500).json({ ok: false, error: error.message ?? "health check failed" }));
  });

  app.post("/sync/push", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid request body" });
    }

    if (typeof body.client_id !== "string" || body.client_id.trim() === "") {
      return res.status(400).json({ error: "client_id is required" });
    }

    if (!Array.isArray(body.records)) {
      return res.status(400).json({ error: "records must be an array" });
    }

    return Promise.resolve(processPushPayload(body))
      .then((response) => {
        // eslint-disable-next-line no-console
        console.log(
          `[sync-server] /sync/push client=${body.client_id} accepted=${response.accepted_outbox_ids?.length ?? 0} rejected=${response.rejected?.length ?? 0}`
        );
        return res.json(response);
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[sync-server] /sync/push failed: ${error.message ?? error}`);
        return res.status(500).json({ error: error.message ?? "sync push failed" });
      });
  });

  app.post("/sync/pull/enqueue", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid request body" });
    }

    if (typeof body.table_name !== "string" || typeof body.operation !== "string" || typeof body.record !== "object") {
      return res.status(400).json({ error: "table_name, operation and record are required" });
    }

    return Promise.resolve(enqueuePullChange(body))
      .then((result) => res.json(result))
      .catch((error) => res.status(500).json({ error: error.message ?? "enqueue failed" }));
  });

  app.get("/debug/state", (_req, res) => {
    return Promise.resolve(getStateSnapshot())
      .then((snapshot) => res.json(snapshot))
      .catch((error) => res.status(500).json({ error: error.message ?? "state fetch failed" }));
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createApp();
  const port = Number(process.env.SYNC_SERVER_PORT ?? 8080);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`STU-LS sync server running on http://localhost:${port}`);
  });
}
