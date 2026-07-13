import express from "express";
import { registerMcpOAuthRoutes } from "../auth/mcpOAuthRoutes.js";
import { registerServiceOAuthRoutes } from "../auth/serviceOAuth.js";
import { registerServiceSetupRoutes } from "../auth/serviceSetup.js";
import { registerConnectorCredentialRoutes } from "../auth/connectorCredentials.js";

export function createApi() {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  registerServiceOAuthRoutes(app);
  registerServiceSetupRoutes(app);
  registerMcpOAuthRoutes(app);
  registerConnectorCredentialRoutes(app);

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "slack-detective" });
  });

  app.use((
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(error);
    response.status(500).json({ error: "Investigation failed" });
  });

  return app;
}
