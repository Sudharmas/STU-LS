import "dotenv/config";
import express from "express";
import cors from "cors";
import { getStorageHealth, processBridgePayload } from "./store.js";

export function createApp(store = { getStorageHealth, processBridgePayload }) {
  const app = express();
  const corsOrigins = (process.env.BACKEND_SERVER_CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (corsOrigins.length > 0) {
    app.use(
      cors({
        origin(origin, callback) {
          if (!origin || corsOrigins.includes(origin)) {
            callback(null, true);
            return;
          }
          callback(new Error("Not allowed by CORS"));
        }
      })
    );
  } else {
    app.use(cors());
  }
  app.use(express.json({ limit: "4mb" }));

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      // eslint-disable-next-line no-console
      console.log(`[backend-server] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
  });

  app.get("/health", (_req, res) => {
    return Promise.resolve(store.getStorageHealth())
      .then((health) => {
        if (!health.ok) {
          return res.status(503).json({ ok: false, service: "stu-ls-backend-server", ...health });
        }
        return res.json({ ok: true, service: "stu-ls-backend-server", ...health });
      })
      .catch((error) => res.status(500).json({ ok: false, error: error.message ?? "health check failed" }));
  });

  app.post("/sync/bridge", (req, res) => {
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

    const configuredToken = (process.env.BACKEND_SERVER_BEARER_TOKEN ?? "").trim();
    if (configuredToken) {
      const header = req.headers.authorization ?? "";
      const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (provided !== configuredToken) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    return Promise.resolve(store.processBridgePayload(body))
      .then((response) => res.json(response))
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[backend-server] /sync/bridge failed: ${error.message ?? error}`);
        return res.status(500).json({ error: error.message ?? "sync bridge failed" });
      });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createApp();
  const port = Number(process.env.PORT ?? process.env.SYNC_SERVER_PORT ?? 8090);
  const host = process.env.SYNC_SERVER_HOST ?? "0.0.0.0";
  app.listen(port, host, () => {
    const publicUrl = process.env.RENDER_EXTERNAL_URL ?? `http://${host}:${port}`;
    // eslint-disable-next-line no-console
    console.log(`STU-LS backend server running on ${publicUrl}`);
  });
}
