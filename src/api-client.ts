import { computeHttpSignature } from "./signer.js";
import type { A2HCredentials } from "./credentials.js";

export class PlatformError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(`A2H API error [${code}]: ${message}`);
    this.name = "PlatformError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface PlatformResponse {
  code?: string | number;
  message?: string;
  data?: unknown;
}

export class A2HApiClient {
  private creds: A2HCredentials;

  constructor(creds: A2HCredentials) {
    this.creds = creds;
  }

  get agentId(): string {
    return this.creds.agentId;
  }

  get credentials(): A2HCredentials {
    return this.creds;
  }

  /**
   * GET with signature. apiPath may include query string.
   * signPath is the path used for signing (without query), auto-extracted if omitted.
   */
  async getJSON<T = unknown>(apiPath: string, signPath?: string): Promise<T> {
    return this.doRequest<T>("GET", this.creds.apiUrl, apiPath, signPath);
  }

  /** POST JSON with signature. */
  async postJSON<T = unknown>(apiPath: string, body?: unknown): Promise<T> {
    return this.doRequest<T>("POST", this.creds.apiUrl, apiPath, undefined, body);
  }

  /** POST JSON to a different base URL (e.g. OSS service). */
  async postJSONToHost<T = unknown>(
    baseUrl: string,
    apiPath: string,
    signPath: string,
    body?: unknown
  ): Promise<T> {
    return this.doRequest<T>("POST", baseUrl.replace(/\/+$/, ""), apiPath, signPath, body);
  }

  /** DELETE with signature. */
  async deleteJSON<T = unknown>(apiPath: string): Promise<T> {
    return this.doRequest<T>("DELETE", this.creds.apiUrl, apiPath);
  }

  /** PUT JSON with signature. */
  async putJSON<T = unknown>(apiPath: string, body?: unknown): Promise<T> {
    return this.doRequest<T>("PUT", this.creds.apiUrl, apiPath, undefined, body);
  }

  /** PUT binary to a pre-signed URL (no business signature). */
  async putBinary(
    uploadUrl: string,
    signedHeaders: Record<string, string>,
    data: Buffer | Uint8Array
  ): Promise<void> {
    const headers: Record<string, string> = { ...signedHeaders };
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      headers,
      body: data as unknown as BodyInit,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`PUT binary HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  private async doRequest<T>(
    method: string,
    baseUrl: string,
    apiPath: string,
    signPath?: string,
    body?: unknown
  ): Promise<T> {
    // Determine signing path (strip query string)
    const effectiveSignPath =
      signPath ?? (apiPath.includes("?") ? apiPath.slice(0, apiPath.indexOf("?")) : apiPath);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeHttpSignature(
      this.creds.agentKey,
      method,
      effectiveSignPath,
      this.creds.agentId,
      timestamp
    );

    const url = baseUrl + apiPath;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-Id": this.creds.agentId,
      "X-Timestamp": timestamp,
      "X-Agent-Signature": signature,
    };

    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify(body ?? {});
    }

    const resp = await fetch(url, init);
    const rawBody = await resp.text();

    if (!resp.ok) {
      let pr: PlatformResponse = {};
      try {
        pr = JSON.parse(rawBody);
      } catch {
        // not JSON
      }
      const msg = pr.message || rawBody.slice(0, 200);
      const code = pr.code != null ? String(pr.code) : String(resp.status);
      throw new PlatformError(code, msg, resp.status);
    }

    // Parse platform wrapper: { code: "200", message: "...", data: T }
    let parsed: PlatformResponse;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // Response is not standard platform format, try direct parse
      return JSON.parse(rawBody) as T;
    }

    // Normalize code (handles both "200" and 200)
    const codeStr = String(parsed.code ?? "").replace(/"/g, "");
    if (codeStr && codeStr !== "200") {
      throw new PlatformError(codeStr, parsed.message ?? "", 0);
    }

    // Return the data field
    if (parsed.data !== undefined && parsed.data !== null) {
      return parsed.data as T;
    }

    return undefined as T;
  }
}
