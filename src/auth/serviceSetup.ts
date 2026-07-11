import { randomBytes } from "node:crypto";
import express from "express";
import { findService, type ServiceDefinition } from "../services/registry.js";
import { setClientCreds } from "./deploymentCreds.js";

/**
 * Secure one-time setup form for a service's provider OAuth app credentials (client id/secret).
 * Linked from Slack when someone asks to connect a service whose credentials this deployment
 * doesn't have yet — the agent walks them through creating the provider app and takes the values
 * here, never in Slack and never via SSH/env edits. The form also discloses every host the
 * integration will contact; submitting it is the human approval that arms a synthesized spec.
 */

const INTENT_TTL_MS = 15 * 60_000;
const setupIntents = new Map<string, { serviceId: string; slackUserId: string; expiresAt: number }>();

export function createServiceSetupIntent(serviceId: string, slackUserId: string): string {
  const secret = randomBytes(24).toString("base64url");
  setupIntents.set(secret, { serviceId, slackUserId, expiresAt: Date.now() + INTENT_TTL_MS });
  return secret;
}

function getIntentService(secret: string): ServiceDefinition | undefined {
  const intent = setupIntents.get(secret);
  if (!intent || intent.expiresAt < Date.now()) {
    setupIntents.delete(secret);
    return undefined;
  }
  return findService(intent.serviceId);
}

export function registerServiceSetupRoutes(app: express.Express, env: NodeJS.ProcessEnv = process.env): void {
  app.get("/auth/service-setup/:secret", (request, response) => {
    const service = getIntentService(String(request.params.secret ?? ""));
    if (!service) {
      response.status(404).type("html").send(page("Invalid link", "This setup link is invalid or expired. Ask the bot to connect the service again for a fresh one."));
      return;
    }
    const callbackUrl = `${env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "<PUBLIC_BASE_URL>"}/auth/services/${service.id}/callback`;
    const instructions = (service.dynamicSpec?.setupInstructions ?? "Create an OAuth application in the provider's developer settings.")
      .replace(/\{CALLBACK_URL\}/g, callbackUrl);
    const hosts = [
      ...new Set([
        ...(service.dynamicSpec?.apiHosts ?? []),
        ...(service.oauth ? [new URL(service.oauth.authorizeUrl).hostname, new URL(service.oauth.tokenUrl).hostname] : [])
      ])
    ];
    response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up ${escapeHtml(service.label)}</title><style>${styles}</style></head>
<body><main><h1>Set up ${escapeHtml(service.label)}</h1>
<p>${linkifyEscaped(escapeHtml(instructions))}</p>
<p><strong>Callback / redirect URL to register:</strong></p>
<div class="copyrow"><code class="copyable" title="Click to copy" data-copy="${escapeHtml(callbackUrl)}">${escapeHtml(callbackUrl)}</code><button type="button" class="copy" data-copy="${escapeHtml(callbackUrl)}">Copy</button></div>
<p><strong>This integration will only ever contact:</strong> ${hosts.map((host) => `<code>${escapeHtml(host)}</code>`).join(", ")} — read-only. Submitting this form approves that.</p>
<form method="post">
<label>Client ID<input name="clientId" required autocomplete="off"></label>
<label>Client secret<input name="clientSecret" type="password" required autocomplete="off"></label>
<button type="submit">Save and enable ${escapeHtml(service.label)}</button>
</form>
<p>These values go directly to the agentkj backend and are never posted to Slack or sent to the language model.</p>
</main>
<script>
document.querySelectorAll("[data-copy]").forEach((element) => {
  element.addEventListener("click", async () => {
    const feedback = element.closest(".copyrow").querySelector(".copy");
    try {
      await navigator.clipboard.writeText(element.dataset.copy);
      feedback.textContent = "Copied!";
    } catch {
      const code = element.closest(".copyrow").querySelector("code");
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      feedback.textContent = "Select + copy";
    }
    setTimeout(() => { feedback.textContent = "Copy"; }, 1600);
  });
});
</script>
</body></html>`);
  });

  app.post("/auth/service-setup/:secret", express.urlencoded({ extended: false }), (request, response) => {
    const secret = String(request.params.secret ?? "");
    const service = getIntentService(secret);
    if (!service) {
      response.status(404).type("html").send(page("Invalid link", "This setup link is invalid or expired."));
      return;
    }
    const clientId = typeof request.body?.clientId === "string" ? request.body.clientId.trim() : "";
    const clientSecret = typeof request.body?.clientSecret === "string" ? request.body.clientSecret.trim() : "";
    if (!clientId || !clientSecret) {
      response.status(400).type("html").send(page("Missing values", "Both the client ID and client secret are required."));
      return;
    }
    setClientCreds(service.id, clientId, clientSecret);
    setupIntents.delete(secret);
    response.type("html").send(page(
      `${escapeHtml(service.label)} is ready`,
      `Credentials saved. Go back to Slack and say “connect ${escapeHtml(service.label.toLowerCase())}” — you'll get your personal connect link.`
    ));
  });
}

const styles = `body{font-family:system-ui,sans-serif;margin:0;background:#f6f6f4}main{max-width:560px;margin:3rem auto;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.06)}h1{font-size:1.3rem}label{display:block;margin:1rem 0;font-weight:600}input{display:block;width:100%;box-sizing:border-box;margin-top:.35rem;padding:.55rem;border:1px solid #ccc;border-radius:8px;font-size:1rem}button{margin-top:.5rem;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#4a154b;color:#fff;font-size:1rem;cursor:pointer}code{background:#f0f0ee;padding:.1rem .35rem;border-radius:4px}.copyrow{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:.4rem 0 1rem}.copyrow code{word-break:break-all;cursor:pointer}.copyrow .copy{margin-top:0;padding:.35rem .8rem;font-size:.85rem}a{color:#4a154b}`;

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${styles}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

/**
 * Turns bare URLs in ALREADY-ESCAPED text into anchors (trailing punctuation stays outside the
 * link). Escape-then-linkify order matters: the match can only contain entity-escaped text, so
 * nothing unescaped ever lands inside the href or the anchor body.
 */
function linkifyEscaped(escaped: string): string {
  return escaped.replace(
    /https?:\/\/[^\s<>"']*[^\s<>"'.,;:)]/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}
