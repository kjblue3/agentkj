import type express from "express";
import { completeCredentialIntent, credentialIntentExists } from "../mcp/connections.js";
import { escapeHtml, renderPage } from "./htmlPage.js";

export function registerConnectorCredentialRoutes(app: express.Express): void {
  app.get("/auth/connectors/:secret", (request, response) => {
    if (!credentialIntentExists(String(request.params.secret ?? ""))) {
      response.status(404).type("html").send(page("Invalid link", "This credential link is invalid or expired."));
      return;
    }
    response.type("html").send(renderPage("Connect service", `<p>Enter the bearer credential issued by the service. It is sent only to this backend.</p><form method="post"><label>Bearer token<input name="token" type="password" required autocomplete="off"></label><label>Granted scopes<input name="scopes" autocomplete="off"></label><button type="submit">Enable connection</button></form>`));
  });
  app.post("/auth/connectors/:secret", bodyParser(), (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const scopes = typeof request.body?.scopes === "string"
      ? request.body.scopes.split(",").map((scope: string) => scope.trim()).filter(Boolean)
      : [];
    try {
      completeCredentialIntent(String(request.params.secret ?? ""), token, scopes);
      response.type("html").send(page("Connected", "The connection is ready. Return to Slack and ask away.", { autoCloseSeconds: 5 }));
    } catch (error) {
      response.status(400).type("html").send(page("Could not connect", escapeHtml(error instanceof Error ? error.message : "The credential was rejected."), { backButton: true }));
    }
  });
}

function bodyParser() {
  return (request: express.Request, response: express.Response, next: express.NextFunction): void => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 32_000) response.status(413).end();
    });
    request.on("end", () => { request.body = Object.fromEntries(new URLSearchParams(body)); next(); });
  };
}

function page(title: string, message: string, options?: { autoCloseSeconds?: number; backButton?: boolean }): string {
  return renderPage(title, `<p>${message}</p>`, options);
}
