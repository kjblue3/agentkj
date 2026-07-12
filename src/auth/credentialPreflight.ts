import { safeFetch } from "../security/publicUrl.js";
import type { DynamicServiceSpec } from "../services/dynamicSpec.js";

/**
 * Live check of freshly submitted OAuth client credentials against the provider itself, so a
 * well-formed but wrong value (another application's id, a regenerated secret) fails on the
 * setup form instead of later on a member's authorize attempt. Providers differ too much for a
 * universal "valid" signal, so this rejects ONLY on definitive provider rejection signals and
 * passes on everything else (unsupported grants, timeouts, odd pages) — a quirky provider must
 * never lock an administrator out of setup.
 */

const PROBE_TIMEOUT_MS = 6000;

/**
 * 4xx authorize-endpoint bodies that specifically disown the client, across provider dialects:
 * RFC error codes ("invalid_client"), prose ("The OAuth client was not found", "Unknown
 * application"), and field-keyed JSON complaints ({"client_id": [...]}). Scope/redirect_uri
 * complaints deliberately do not match — those mean the client id WAS recognized.
 */
const CLIENT_REJECTION =
  /invalid[_ ]?client|(?:unknown|invalid|unrecognized) +(?:client|application)|(?:client|application) +(?:was +)?not +found|"client_id"/i;

export type CredentialPreflight = (
  spec: DynamicServiceSpec,
  clientId: string,
  clientSecret: string,
  callbackUrl: string,
  label: string
) => Promise<string | null>;

export const clientCredentialPreflight: CredentialPreflight = async (
  spec,
  clientId,
  clientSecret,
  callbackUrl,
  label
) => {
  // Probe 1: does the authorization endpoint recognize this client id at all? A real request
  // (however incomplete) from a valid client draws a login page or a scope/redirect complaint;
  // an unknown client draws an explicit client rejection.
  try {
    const probe = new URL(spec.oauth.authorizeUrl);
    probe.searchParams.set("response_type", "code");
    probe.searchParams.set("client_id", clientId);
    probe.searchParams.set("redirect_uri", callbackUrl);
    if (spec.oauth.scope) probe.searchParams.set("scope", spec.oauth.scope);
    const response = await safeFetch(probe.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "text/html,application/json" }
    });
    if (response.status >= 400 && response.status < 500) {
      const body = (await response.text()).slice(0, 4000);
      if (CLIENT_REJECTION.test(body)) {
        return `${label} did not recognize this client ID. Check that you copied it from the same application whose secret you are entering.`;
      }
    }
  } catch {
    // Unreachable or slow endpoints prove nothing about the credentials.
  }

  // Probe 2: does the token endpoint accept the id+secret pair? Credentials ride both RFC 6749
  // mechanisms at once (Basic header and body params) because providers disagree on which they
  // read; a server that objects to the duplication answers invalid_request, which passes. Only
  // an explicit invalid_client — an authentication verdict — is conclusive.
  try {
    const response = await safeFetch(spec.oauth.tokenUrl, {
      method: "POST",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString()
    });
    if (response.status === 400 || response.status === 401) {
      const body = (await response.text()).slice(0, 4000);
      let code: unknown;
      try {
        code = (JSON.parse(body) as { error?: unknown }).error;
      } catch {
        return null;
      }
      if (code === "invalid_client") {
        return `${label} rejected this client ID and secret as a pair. The secret may have been regenerated, or it belongs to a different application.`;
      }
    }
  } catch {
    // Fail open: absence of proof is not proof of a bad secret.
  }
  return null;
};
