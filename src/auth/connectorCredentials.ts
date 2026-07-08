import type express from "express";
import {
  consumeUserConnectorCredentialIntent,
  getUserConnectorCredentialIntent,
  setUserConnector
} from "./tokenStore.js";
import {
  completeCredentialIntent,
  credentialIntentExists
} from "../mcp/connections.js";
import { findCatalogEntry } from "../mcp/catalog.js";

export function registerConnectorCredentialRoutes(app: express.Express): void {
  app.get("/auth/connectors/:secret", (request, response) => {
    if (!credentialIntentExists(request.params.secret)) {
      response.status(404).type("html").send(page("Invalid link", "This credential link is invalid or expired."));
      return;
    }
    response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect service</title><style>${styles}</style></head>
<body><main><h1>Connect service</h1>
<p>Enter the bearer credential issued by the service. It goes directly to the agentkj backend and is never posted to Slack or sent to the language model.</p>
<form method="post">
<label>Bearer token<input name="token" type="password" required autocomplete="off"></label>
<label>Provider scopes (optional, comma separated)<input name="scopes" autocomplete="off" placeholder="read:activities, profile"></label>
<button type="submit">Save credential and enable</button>
</form></main></body></html>`);
  });

  app.post(
    "/auth/connectors/:secret",
    bodyParser(),
    (request, response) => {
      const token = typeof request.body?.token === "string" ? request.body.token : "";
      const scopes = typeof request.body?.scopes === "string"
        ? request.body.scopes.split(",").map((scope: string) => scope.trim()).filter(Boolean)
        : [];
      try {
        const connection = completeCredentialIntent(String(request.params.secret ?? ""), token, scopes);
        response.type("html").send(page(
          "Connected",
          `${escapeHtml(connection.name)} is enabled. You can close this tab and ask agentkj to use it in Slack.`
        ));
      } catch (error) {
        response.status(400).type("html").send(page(
          "Could not connect",
          escapeHtml(error instanceof Error ? error.message : "The credential could not be saved.")
        ));
      }
    }
  );

  app.get("/auth/catalog-connectors/:secret", (request, response) => {
    const intent = getUserConnectorCredentialIntent(request.params.secret);
    const entry = intent ? findCatalogEntry(intent.catalogId) : undefined;
    if (!intent || !entry) {
      response.status(404).type("html").send(page("Invalid link", "This connector setup link is invalid or expired."));
      return;
    }
    const fields = entry.credentialFields.map((field) =>
      `<label>${escapeHtml(field)}<input name="${escapeHtml(field)}" type="password" required autocomplete="off"></label>`
    ).join("\n");
    response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${escapeHtml(entry.label)}</title><style>${styles}</style></head>
<body><main><h1>Connect ${escapeHtml(entry.label)}</h1>
<p>Enter the setup values for this vetted connector. They go directly to the agentkj backend and are never posted to Slack or sent to the language model.</p>
<form method="post">${fields}<button type="submit">Save connector</button></form>
</main></body></html>`);
  });

  app.post(
    "/auth/catalog-connectors/:secret",
    bodyParser(),
    (request, response) => {
      const intent = getUserConnectorCredentialIntent(String(request.params.secret ?? ""));
      const entry = intent ? findCatalogEntry(intent.catalogId) : undefined;
      if (!intent || !entry) {
        response.status(404).type("html").send(page("Invalid link", "This connector setup link is invalid or expired."));
        return;
      }

      const credentials = Object.fromEntries(
        entry.credentialFields.map((field) => [field, typeof request.body?.[field] === "string" ? request.body[field] : ""])
      ) as Record<string, string>;
      const missing = entry.credentialFields.filter((field) => !credentials[field]?.trim());
      if (missing.length > 0) {
        response.status(400).type("html").send(page(
          "Could not connect",
          `Missing required setup values: ${escapeHtml(missing.join(", "))}.`
        ));
        return;
      }

      consumeUserConnectorCredentialIntent(String(request.params.secret ?? ""));
      setUserConnector(intent.slackUserId, {
        catalogId: entry.id,
        label: entry.label,
        credentials,
        connectedAt: new Date().toISOString()
      });
      response.type("html").send(page(
        "Connected",
        `${escapeHtml(entry.label)} is enabled. You can close this tab and ask agentkj to use it in Slack.`
      ));
    }
  );
}

function bodyParser() {
  return (request: express.Request, response: express.Response, next: express.NextFunction): void => {
    let body = "";
    request.setEncoding("utf8");
    let rejected = false;
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 32_000 && !rejected) {
        rejected = true;
        response.status(413).end();
      }
    });
    request.on("end", () => {
      if (rejected) return;
      request.body = Object.fromEntries(new URLSearchParams(body));
      next();
    });
  };
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${styles}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

const styles =
  "body{font:16px system-ui;background:#f7f7f8;color:#202124;margin:0}main{max-width:560px;margin:10vh auto;background:white;padding:32px;border-radius:14px;box-shadow:0 8px 32px #0001}label{display:block;margin:20px 0}input{box-sizing:border-box;width:100%;padding:12px;margin-top:7px;border:1px solid #bbb;border-radius:8px}button{background:#4a154b;color:white;border:0;border-radius:8px;padding:12px 18px;font-weight:700}";
