import type express from "express";
import { completeCredentialIntent, credentialIntentExists } from "../mcp/connections.js";

export function registerConnectorCredentialRoutes(app: express.Express): void {
  app.get("/auth/connectors/:secret", (request, response) => {
    if (!credentialIntentExists(String(request.params.secret ?? ""))) {
      response.status(404).type("html").send(page("Invalid link", "This credential link is invalid or expired."));
      return;
    }
    response.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><main><h1>Connect service</h1><p>Enter the bearer credential issued by the service. It is sent only to this backend.</p><form method="post"><label>Bearer token<input name="token" type="password" required autocomplete="off"></label><label>Granted scopes<input name="scopes" autocomplete="off"></label><button type="submit">Enable connection</button></form></main></body></html>`);
  });
  app.post("/auth/connectors/:secret", bodyParser(), (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const scopes = typeof request.body?.scopes === "string"
      ? request.body.scopes.split(",").map((scope: string) => scope.trim()).filter(Boolean)
      : [];
    try {
      completeCredentialIntent(String(request.params.secret ?? ""), token, scopes);
      response.type("html").send(page("Connected", "The connection is ready. You can close this tab and return to Slack."));
    } catch (error) {
      response.status(400).type("html").send(page("Could not connect", escapeHtml(error instanceof Error ? error.message : "The credential was rejected.")));
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

function page(title: string, message: string): string { return `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
const styles = "body{font:16px system-ui;background:#f7f7f8;margin:0}main{max-width:560px;margin:10vh auto;background:#fff;padding:32px;border-radius:14px}label{display:block;margin:20px 0}input{box-sizing:border-box;width:100%;padding:12px;margin-top:7px}button{padding:12px 18px;background:#4a154b;color:#fff;border:0;border-radius:8px}";
