import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EvidenceItem, InvestigationQuery } from "../types/schemas.js";
import type { EvidenceConnector } from "./types.js";
import {
  buildEntities,
  buildTags,
  fetchJson,
  normalizeEvidenceItem,
  queryTerms,
  type FetchLike
} from "./connectorUtils.js";

interface GoogleDriveSearchResponse {
  files?: GoogleDriveFile[];
}

interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType?: string;
  webViewLink?: string;
  modifiedTime?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type GoogleAuthConfig =
  | { accessToken: string }
  | { serviceAccountJson: string }
  | { clientId: string; clientSecret: string; refreshToken: string };

export class GoogleDriveConnector implements EvidenceConnector {
  readonly name = "Google Drive";
  private readonly cache = new Map<string, EvidenceItem>();
  private tokenCache?: { token: string; expiresAt: number };

  constructor(
    private readonly auth: GoogleAuthConfig,
    private readonly folderIds: string[],
    private readonly fetcher: FetchLike = fetch
  ) {}

  async search(query: InvestigationQuery): Promise<EvidenceItem[]> {
    const token = await this.getAccessToken();
    if (!token) return [];
    const params = new URLSearchParams({
      q: this.buildDriveQuery(query),
      pageSize: "10",
      fields: "files(id,name,mimeType,webViewLink,modifiedTime,owners)"
    });
    const payload = await fetchJson<GoogleDriveSearchResponse>(
      this.fetcher,
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
      this.name
    );
    const files = payload?.files ?? [];
    return Promise.all(files.map((file) => this.toEvidence(file, query, token)));
  }

  async getById(id: string): Promise<EvidenceItem | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const match = /^docs:(.+)$/.exec(id);
    if (!match) return null;
    const token = await this.getAccessToken();
    if (!token) return null;
    const fileId = match[1];
    if (!fileId) return null;
    const file = await fetchJson<GoogleDriveFile>(
      this.fetcher,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink,modifiedTime,owners`,
      { headers: { Authorization: `Bearer ${token}` } },
      this.name
    );
    return file ? this.toEvidence(file, { originalQuestion: "", keywords: [], entities: [], tags: [] }, token) : null;
  }

  private buildDriveQuery(query: InvestigationQuery): string {
    const terms = queryTerms(query).slice(0, 5);
    const termClauses = terms.map((term) => `fullText contains '${term.replace(/'/g, "\\'")}'`);
    const folderClauses = this.folderIds.map((id) => `'${id.replace(/'/g, "\\'")}' in parents`);
    return [
      "trashed = false",
      folderClauses.length > 0 ? `(${folderClauses.join(" or ")})` : "",
      termClauses.length > 0 ? `(${termClauses.join(" or ")})` : ""
    ].filter(Boolean).join(" and ");
  }

  private async toEvidence(
    file: GoogleDriveFile,
    query: InvestigationQuery,
    token: string
  ): Promise<EvidenceItem> {
    const body = await this.fetchText(file, token);
    const owner = file.owners?.[0];
    const item = normalizeEvidenceItem({
      id: `docs:${file.id}`,
      source: "docs",
      title: `Google Drive: ${file.name}`,
      body: body || `Drive search match for ${file.name}.`,
      url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      author: owner?.displayName ?? owner?.emailAddress,
      timestamp: file.modifiedTime,
      entities: buildEntities(query, `${file.name} ${body}`, [file.name]),
      tags: buildTags(query, ["docs", "drive"]),
      confidence: body ? 0.66 : 0.5
    });
    this.cache.set(item.id, item);
    return item;
  }

  private async fetchText(file: GoogleDriveFile, token: string): Promise<string> {
    const isGoogleDoc = file.mimeType === "application/vnd.google-apps.document";
    const url = isGoogleDoc
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text/plain`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
    try {
      const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return "";
      return (await response.text()).replace(/\s+/g, " ").trim();
    } catch (error) {
      console.warn(`${this.name} text export failed.`, error);
      return "";
    }
  }

  private async getAccessToken(): Promise<string | null> {
    if ("accessToken" in this.auth) return this.auth.accessToken;
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) return this.tokenCache.token;

    const token = "serviceAccountJson" in this.auth
      ? await this.serviceAccountToken(this.auth.serviceAccountJson)
      : await this.refreshToken(this.auth.clientId, this.auth.clientSecret, this.auth.refreshToken);
    if (token?.access_token) {
      this.tokenCache = {
        token: token.access_token,
        expiresAt: now + (token.expires_in ?? 3600) * 1000
      };
      return token.access_token;
    }
    return null;
  }

  private async serviceAccountToken(rawOrPath: string): Promise<GoogleTokenResponse | null> {
    const serviceAccount = await this.loadServiceAccount(rawOrPath);
    if (!serviceAccount) return null;
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64Url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    }));
    const unsigned = `${header}.${claim}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key);
    const assertion = `${unsigned}.${base64Url(signature)}`;
    return fetchJson<GoogleTokenResponse>(
      this.fetcher,
      serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion
        })
      },
      this.name
    );
  }

  private async refreshToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string
  ): Promise<GoogleTokenResponse | null> {
    return fetchJson<GoogleTokenResponse>(
      this.fetcher,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token"
        })
      },
      this.name
    );
  }

  private async loadServiceAccount(rawOrPath: string): Promise<GoogleServiceAccount | null> {
    try {
      const raw = rawOrPath.trim().startsWith("{") ? rawOrPath : await readFile(rawOrPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<GoogleServiceAccount>;
      if (parsed.client_email && parsed.private_key) {
        return {
          client_email: parsed.client_email,
          private_key: parsed.private_key,
          token_uri: parsed.token_uri
        };
      }
    } catch (error) {
      console.warn(`${this.name} service account could not be loaded.`, error);
    }
    return null;
  }
}

function base64Url(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
