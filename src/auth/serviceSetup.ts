import express from "express";
import { findService } from "../services/registry.js";
import {
  consumeOAuthIntent,
  createOAuthIntent,
  getOAuthIntent,
  getWorkspaceClientCredentials,
  setWorkspaceClientCredentials
} from "../state/repositories.js";
import { isWorkspaceAdministrator } from "./workspaceAdmin.js";
import { clientCredentialPreflight, type CredentialPreflight } from "./credentialPreflight.js";

export function createServiceSetupIntent(
  serviceId: string,
  workspaceId: string,
  userId: string,
  expectedVersion = getWorkspaceClientCredentials(workspaceId, serviceId)?.version ?? 0
): string {
  return createOAuthIntent({ kind: "setup", serviceId, workspaceId, userId, expectedVersion });
}

export function registerServiceSetupRoutes(
  app: express.Express,
  env: NodeJS.ProcessEnv = process.env,
  adminCheck = isWorkspaceAdministrator,
  preflight: CredentialPreflight = clientCredentialPreflight
): void {
  app.get("/auth/service-setup/:secret", async (request, response) => {
    const secret = String(request.params.secret ?? "");
    const intent = getOAuthIntent(secret, "setup");
    const service = intent ? findService(intent.serviceId) : undefined;
    if (!intent || !service || !await adminCheck(intent.workspaceId, intent.userId, { env })) {
      response.status(404).type("html").send(page("Invalid setup link", "This link is invalid, expired, or no longer authorized."));
      return;
    }
    if (getWorkspaceClientCredentials(intent.workspaceId, service.id, env)?.source === "environment") {
      response.status(409).type("html").send(page("Already configured", "This service is configured by the deployment environment and cannot be replaced here."));
      return;
    }
    const callbackUrl = `${env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "<PUBLIC_BASE_URL>"}/auth/services/${service.id}/callback`;
    const instructions = service.dynamicSpec.setupInstructions.replace(/\{CALLBACK_URL\}/g, callbackUrl);
    const replacing = (intent.expectedVersion ?? 0) > 0;
    response.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configure ${escapeHtml(service.label)}</title><style>${styles}</style></head><body><main><h1>${replacing ? "Replace" : "Configure"} ${escapeHtml(service.label)}</h1><p><strong>Administrator task:</strong> register one provider application for this Slack workspace. Other members will only authorize their own accounts.</p><p>${escapeHtml(instructions)}</p><p><strong>Callback URL:</strong> <code>${escapeHtml(callbackUrl)}</code></p><p>This read-only integration may contact: ${service.dynamicSpec.apiHosts.map((host) => `<code>${escapeHtml(host)}</code>`).join(", ")}.</p>${replacing ? "<p><strong>Replacing these credentials will require every connected member to authorize again.</strong></p>" : ""}<form method="post"><label>Client ID<input name="clientId" required autocomplete="off"${service.dynamicSpec.oauth.clientIdPattern ? ` pattern="${escapeHtml(service.dynamicSpec.oauth.clientIdPattern)}"` : ""}${service.dynamicSpec.oauth.clientIdHint ? ` title="${escapeHtml(service.dynamicSpec.oauth.clientIdHint)}"` : ""}>${service.dynamicSpec.oauth.clientIdHint ? `<small>${escapeHtml(service.dynamicSpec.oauth.clientIdHint)}</small>` : ""}</label><label>Client secret<input name="clientSecret" type="password" required autocomplete="off"></label>${replacing ? '<label class="confirm"><input name="confirmReplace" type="checkbox" value="yes" required> I understand existing grants will require reauthorization.</label>' : ""}<button type="submit">${replacing ? "Replace" : "Save"} workspace configuration</button></form><p>These values go directly to the backend and are never posted to Slack or sent to the language model.</p></main></body></html>`);
  });

  app.post("/auth/service-setup/:secret", express.urlencoded({ extended: false, limit: "32kb" }), async (request, response) => {
    const secret = String(request.params.secret ?? "");
    const preview = getOAuthIntent(secret, "setup");
    if (!preview || !await adminCheck(preview.workspaceId, preview.userId, { fresh: true, env })) {
      response.status(403).type("html").send(page("Setup denied", "Your workspace administrator status could not be verified."));
      return;
    }
    // Validate everything against the previewed intent BEFORE consuming it, so a rejected
    // submission leaves the one-time link usable and the administrator can simply retry.
    const service = findService(preview.serviceId);
    const clientId = typeof request.body?.clientId === "string" ? request.body.clientId.trim() : "";
    const clientSecret = typeof request.body?.clientSecret === "string" ? request.body.clientSecret.trim() : "";
    if (!service || !clientId || !clientSecret) {
      response.status(400).type("html").send(page("Setup failed", "Required values were missing. Go back and complete both fields."));
      return;
    }
    if ((preview.expectedVersion ?? 0) > 0 && request.body?.confirmReplace !== "yes") {
      response.status(400).type("html").send(page("Confirmation required", "Credential replacement was not confirmed. Go back and confirm to continue."));
      return;
    }
    const problem = clientCredentialProblem(service, clientId, clientSecret);
    if (problem) {
      response.status(400).type("html").send(page("Check the credentials", `${escapeHtml(problem)} This setup link is still valid — go back and correct the values.`));
      return;
    }
    const callbackUrl = `${env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? ""}/auth/services/${service.id}/callback`;
    const rejection = await preflight(service.dynamicSpec, clientId, clientSecret, callbackUrl, service.label).catch(() => null);
    if (rejection) {
      response.status(400).type("html").send(page("The provider rejected these credentials", `${escapeHtml(rejection)} This setup link is still valid — go back and correct the values.`));
      return;
    }
    const intent = consumeOAuthIntent(secret, "setup");
    if (!intent) {
      response.status(400).type("html").send(page("Setup failed", "The link expired or was already used. Request a fresh setup link."));
      return;
    }
    try {
      setWorkspaceClientCredentials({
        workspaceId: intent.workspaceId,
        serviceId: service.id,
        clientId,
        clientSecret,
        configuredBy: intent.userId,
        expectedVersion: intent.expectedVersion,
        env
      });
      response.type("html").send(page(`${escapeHtml(service.label)} is ready`, "Workspace configuration saved. Members can now authorize their own accounts from Slack."));
    } catch (error) {
      response.status(409).type("html").send(page("Setup changed", escapeHtml(error instanceof Error ? error.message : "Request a fresh setup link.")));
    }
  });
}

/**
 * Rejects credentials that can never work at the provider, so a wrong-field paste fails on the
 * form instead of later at the provider's authorize page. Returns a problem message or null.
 */
function clientCredentialProblem(
  service: NonNullable<ReturnType<typeof findService>>,
  clientId: string,
  clientSecret: string
): string | null {
  if (clientId === clientSecret) {
    return "The client ID and client secret are identical — one value was pasted into the wrong field.";
  }
  if (clientId.length > 200 || /[^\x21-\x7e]/.test(clientId)) {
    return "The client ID contains spaces or unusual characters. Copy it exactly from the provider's application settings.";
  }
  if (clientSecret.length > 500 || /[^\x21-\x7e]/.test(clientSecret)) {
    return "The client secret contains spaces or unusual characters. Copy it exactly from the provider's application settings.";
  }
  const pattern = service.dynamicSpec.oauth.clientIdPattern;
  if (pattern) {
    try {
      if (!new RegExp(`^(?:${pattern})$`).test(clientId)) {
        const hint = service.dynamicSpec.oauth.clientIdHint;
        return `That doesn't look like a ${service.label} client ID${hint ? ` — expected ${hint}` : ""}. Check that you copied the client ID, not the secret or a key from another product.`;
      }
    } catch {
      // A stored pattern that no longer compiles must never lock administrators out.
    }
  }
  return null;
}

const styles = "body{font:16px system-ui;background:#f7f7f8;margin:0}main{max-width:620px;margin:8vh auto;background:#fff;padding:32px;border-radius:14px;box-shadow:0 8px 32px #0001}label{display:block;margin:18px 0;font-weight:600}input{box-sizing:border-box;width:100%;padding:11px;margin-top:6px}.confirm input{width:auto}small{display:block;font-weight:400;color:#555;margin-top:4px}button{padding:12px 18px;background:#4a154b;color:#fff;border:0;border-radius:8px}code{word-break:break-all;background:#eee;padding:2px 5px}";
function page(title: string, message: string): string { return `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
