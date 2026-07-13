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
import { copyableValue, escapeHtml, linkifyHtml, renderPage } from "./htmlPage.js";
import { serviceConnectUrl } from "./serviceOAuth.js";
import { directMessageUser } from "../slack/notify.js";

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
    const oauth = service.dynamicSpec.oauth;
    const body =
      `<p><strong>Administrator task:</strong> register one provider application for this Slack workspace. Other members will only authorize their own accounts.</p>` +
      `<p>${linkifyHtml(instructions)}</p>` +
      `<p><strong>Callback URL:</strong> ${copyableValue(callbackUrl)}</p>` +
      `<p>This read-only integration may contact: ${service.dynamicSpec.apiHosts.map((host) => `<code>${escapeHtml(host)}</code>`).join(", ")}.</p>` +
      (replacing ? "<p><strong>Replacing these credentials will require every connected member to authorize again.</strong></p>" : "") +
      `<form method="post"><label>Client ID<input name="clientId" required autocomplete="off"${oauth.clientIdPattern ? ` pattern="${escapeHtml(oauth.clientIdPattern)}"` : ""}${oauth.clientIdHint ? ` title="${escapeHtml(oauth.clientIdHint)}"` : ""}>${oauth.clientIdHint ? `<small>${escapeHtml(oauth.clientIdHint)}</small>` : ""}</label><label>Client secret<input name="clientSecret" type="password" required autocomplete="off"></label>${oauth.clientIdPattern ? `<label class="confirm"><input name="formatOverride" type="checkbox" value="yes" onchange="var i=this.form.clientId;if(this.checked){i.dataset.p=i.getAttribute('pattern')||'';i.removeAttribute('pattern')}else if(i.dataset.p){i.setAttribute('pattern',i.dataset.p)}"> My client ID doesn’t match the expected format, but I’ve double-checked it against the provider’s settings page.</label>` : ""}${replacing ? '<label class="confirm"><input name="confirmReplace" type="checkbox" value="yes" required> I understand existing grants will require reauthorization.</label>' : ""}<button type="submit">${replacing ? "Replace" : "Save"} workspace configuration</button></form>` +
      `<p>These values go directly to the backend and are never posted to Slack or sent to the language model.</p>`;
    response.type("html").send(renderPage(`${replacing ? "Replace" : "Configure"} ${service.label}`, body));
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
      response.status(400).type("html").send(page("Setup failed", "Required values were missing. Go back and complete both fields.", { backButton: true }));
      return;
    }
    if ((preview.expectedVersion ?? 0) > 0 && request.body?.confirmReplace !== "yes") {
      response.status(400).type("html").send(page("Confirmation required", "Credential replacement was not confirmed. Go back and confirm to continue.", { backButton: true }));
      return;
    }
    const formatOverride = request.body?.formatOverride === "yes";
    const problem = clientCredentialProblem(service, clientId, clientSecret, formatOverride);
    if (problem) {
      response.status(400).type("html").send(page("Check the credentials", `${escapeHtml(problem)} This setup link is still valid.`, { backButton: true }));
      return;
    }
    const callbackUrl = `${env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? ""}/auth/services/${service.id}/callback`;
    const verdict = await preflight(service.dynamicSpec, clientId, clientSecret, callbackUrl, service.label).catch(() => null);
    if (verdict && !(verdict.overridable && formatOverride)) {
      const hint = verdict.overridable ? " If you’ve double-checked and it IS right, tick the format-override box and save again." : "";
      response.status(400).type("html").send(page("The provider rejected these credentials", `${escapeHtml(verdict.problem)}${escapeHtml(hint)} This setup link is still valid.`, { backButton: true }));
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
      response.type("html").send(page(`${service.label} is ready`, "Workspace configuration saved. Check Slack — I’ve sent you the link to connect your own account.", { autoCloseSeconds: 5 }));
      // Close the loop in Slack: hand the administrator their own authorize link immediately
      // instead of making them ask "connect <service>" a second time.
      const connectUrl = serviceConnectUrl(service, intent.workspaceId, intent.userId, undefined, env);
      if (connectUrl) {
        void directMessageUser(intent.workspaceId, intent.userId,
          `*${service.label}* is set up for this workspace! Next step: <${connectUrl}|connect your own account> (read-only). After you authorize, just ask me questions that need it.`);
      }
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
  clientSecret: string,
  formatOverride = false
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
  // The expected-format pattern is LLM-drafted and can simply be wrong (a provider's newer id
  // generation, say) — so the admin can override it on the form. The universal checks above and
  // the live provider preflight still apply; only this guess is skippable.
  const pattern = service.dynamicSpec.oauth.clientIdPattern;
  if (pattern && !formatOverride) {
    try {
      if (!new RegExp(`^(?:${pattern})$`).test(clientId)) {
        const hint = service.dynamicSpec.oauth.clientIdHint;
        return `That doesn't look like a ${service.label} client ID${hint ? ` — expected ${hint}` : ""}. Check that you copied the client ID, not the secret or a key from another product. If you've double-checked and it IS right, tick the format-override box and save again.`;
      }
    } catch {
      // A stored pattern that no longer compiles must never lock administrators out.
    }
  }
  return null;
}

function page(title: string, message: string, options?: { autoCloseSeconds?: number; backButton?: boolean }): string {
  return renderPage(title, `<p>${message}</p>`, options);
}
