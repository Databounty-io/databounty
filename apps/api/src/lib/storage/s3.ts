// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { config } from "../../config.js";
import type {
  DirectUploadStorageDriver,
  DirectUploadTarget,
  MultipartCompletedPart,
  MultipartPartDeclaration,
  MultipartUploadPlan,
  MultipartUploadStorageDriver,
  ObjectMetadata,
  StoredObject,
} from "./types.js";

/** Strict RFC 3986 percent-encoding for SigV4 canonical query strings.
 * encodeURIComponent leaves `!*'()` unescaped; SigV4 requires them escaped. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const hexToBase64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

type S3Options = {
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
};

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function encodedPath(key: string): string {
  return `/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(config.storage.requestTimeoutMs) });
}

/**
 * Minimal native-fetch S3 client, ported faithfully from v1 databounty-api
 * (`src/lib/storage/s3.ts`). It signs each request with AWS SigV4 and avoids
 * adding an SDK/runtime dependency to the API artifact path — deliberate, not
 * an oversight: no `@aws-sdk/*` package is a dependency of this service (see
 * package.json), matching v1's own choice.
 */
export class S3Driver implements DirectUploadStorageDriver, MultipartUploadStorageDriver {
  readonly name = "s3";
  readonly bucket: string;
  private readonly endpoint: string;
  private cachedRoleCreds: { creds: AwsCredentials; expiresAt: number } | null = null;

  constructor(private readonly options: S3Options) {
    if (!options.bucket || !options.region) {
      throw new Error("S3 storage requires STORAGE_BUCKET and STORAGE_REGION");
    }
    this.bucket = options.bucket;
    this.endpoint = (options.endpoint || `https://s3.${options.region}.amazonaws.com`).replace(/\/$/, "");
  }

  private requestUrl(key: string): URL {
    return new URL(`${this.endpoint}/${encodeURIComponent(this.bucket)}${encodedPath(key)}`);
  }

  private async credentials(): Promise<AwsCredentials> {
    if (this.options.accessKeyId && this.options.secretAccessKey) {
      return {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
        sessionToken: this.options.sessionToken || undefined,
      };
    }
    const now = Date.now();
    if (this.cachedRoleCreds && this.cachedRoleCreds.expiresAt - now > 60_000) return this.cachedRoleCreds.creds;

    const tokenRes = await fetchWithTimeout("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
    });
    if (!tokenRes.ok) throw new Error("S3 storage could not resolve AWS credentials from env or EC2 instance metadata");
    const token = await tokenRes.text();
    const roleRes = await fetchWithTimeout("http://169.254.169.254/latest/meta-data/iam/security-credentials/", {
      headers: { "x-aws-ec2-metadata-token": token },
    });
    if (!roleRes.ok) throw new Error("S3 storage could not resolve EC2 instance role name");
    const roleName = (await roleRes.text()).split("\n").find(Boolean);
    if (!roleName) throw new Error("S3 storage EC2 instance role name was empty");
    const credsRes = await fetchWithTimeout(`http://169.254.169.254/latest/meta-data/iam/security-credentials/${encodeURIComponent(roleName)}`, {
      headers: { "x-aws-ec2-metadata-token": token },
    });
    if (!credsRes.ok) throw new Error("S3 storage could not resolve EC2 role credentials");
    const data = (await credsRes.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
      Expiration?: string;
    };
    if (!data.AccessKeyId || !data.SecretAccessKey) throw new Error("S3 storage received incomplete EC2 role credentials");
    const creds = { accessKeyId: data.AccessKeyId, secretAccessKey: data.SecretAccessKey, sessionToken: data.Token };
    this.cachedRoleCreds = { creds, expiresAt: data.Expiration ? Date.parse(data.Expiration) : now + 5 * 60_000 };
    return creds;
  }

  private signingKey(secretAccessKey: string, date: string): Buffer {
    const kDate = hmac(`AWS4${secretAccessKey}`, date);
    const kRegion = hmac(kDate, this.options.region);
    const kService = hmac(kRegion, "s3");
    return hmac(kService, "aws4_request");
  }

  private async signedHeaders(
    method: string,
    url: URL,
    payloadHash: string,
    contentType?: string,
    extraHeaders?: Record<string, string>
  ) {
    const creds = await this.credentials();
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };
    if (contentType) headers["content-type"] = contentType;
    if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
    // The canonical request MUST include the canonical query string. Object
    // PUT/GET/HEAD/DELETE carry no query (empty), but the multipart subresource
    // calls do — CreateMultipartUpload (`?uploads=`), CompleteMultipartUpload /
    // AbortMultipartUpload (`?uploadId=…`) — and omitting it yields
    // SignatureDoesNotMatch. Params are RFC-3986-encoded and sorted by encoded
    // key then value, per AWS SigV4.
    const canonicalQuery = [...url.searchParams.entries()]
      .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", this.signingKey(creds.secretAccessKey, date)).update(stringToSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
    return headers;
  }

  async put(key: string, body: Readable, contentType: string): Promise<StoredObject> {
    const bytes = await collect(body);
    const payloadHash = sha256(bytes);
    const url = this.requestUrl(key);
    const response = await fetchWithTimeout(url, { method: "PUT", headers: await this.signedHeaders("PUT", url, payloadHash, contentType), body: bytes });
    if (!response.ok) throw new Error(`S3 PUT failed (${response.status})`);
    return { sizeBytes: bytes.length, checksumSha256: payloadHash };
  }

  async get(key: string): Promise<Readable> {
    const url = this.requestUrl(key);
    const response = await fetchWithTimeout(url, { method: "GET", headers: await this.signedHeaders("GET", url, sha256("")) });
    if (!response.ok || !response.body) throw new Error(`S3 GET failed (${response.status})`);
    return Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  }

  async head(key: string): Promise<ObjectMetadata> {
    const url = this.requestUrl(key);
    const headers = await this.signedHeaders("HEAD", url, sha256(""), undefined, { "x-amz-checksum-mode": "ENABLED" });
    const response = await fetchWithTimeout(url, { method: "HEAD", headers });
    if (!response.ok) throw new Error(`S3 HEAD failed (${response.status})`);
    return {
      sizeBytes: Number(response.headers.get("content-length") ?? 0),
      checksumSha256: response.headers.get("x-amz-checksum-sha256"),
      contentType: response.headers.get("content-type"),
    };
  }

  async remove(key: string): Promise<void> {
    const url = this.requestUrl(key);
    const response = await fetchWithTimeout(url, { method: "DELETE", headers: await this.signedHeaders("DELETE", url, sha256("")) });
    if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE failed (${response.status})`);
  }

  async createDirectUpload(params: {
    key: string;
    contentType: string;
    maxBytes: number;
    checksumSha256Hex: string;
    expiresSeconds: number;
  }): Promise<DirectUploadTarget> {
    const creds = await this.credentials();
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const expiresAt = new Date(now.getTime() + params.expiresSeconds * 1000);
    const fields: Record<string, string> = {
      key: params.key,
      "Content-Type": params.contentType,
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": `${creds.accessKeyId}/${scope}`,
      "x-amz-date": amzDate,
      "x-amz-checksum-sha256": Buffer.from(params.checksumSha256Hex, "hex").toString("base64"),
    };
    if (creds.sessionToken) fields["x-amz-security-token"] = creds.sessionToken;
    const conditions: unknown[] = [
      { bucket: this.bucket },
      { key: params.key },
      { "Content-Type": params.contentType },
      { "x-amz-algorithm": fields["x-amz-algorithm"] },
      { "x-amz-credential": fields["x-amz-credential"] },
      { "x-amz-date": fields["x-amz-date"] },
      { "x-amz-checksum-sha256": fields["x-amz-checksum-sha256"] },
      ["content-length-range", 1, params.maxBytes],
    ];
    if (creds.sessionToken) conditions.push({ "x-amz-security-token": creds.sessionToken });
    const policy = Buffer.from(JSON.stringify({ expiration: expiresAt.toISOString(), conditions })).toString("base64");
    fields.policy = policy;
    fields["x-amz-signature"] = createHmac("sha256", this.signingKey(creds.secretAccessKey, date)).update(policy).digest("hex");
    return { mode: "form_post", method: "POST", url: `${this.endpoint}/${encodeURIComponent(this.bucket)}`, fields, expiresAt };
  }

  // ---- Multipart upload (large objects, S3-only) ---------------------------
  // Three-call S3 flow (CreateMultipartUpload → UploadPart×N → Complete), with
  // per-part SHA-256 bound into each part's presigned PUT so object storage
  // rejects a part whose bytes don't match — the same integrity guarantee the
  // single-PUT POST-policy path has, applied per part. The bytes never touch
  // this API. Local dev uses the disk driver, which has no multipart
  // capability and falls back to the single-slot content-route upload,
  // exactly like createDirectUpload.

  async createMultipartUpload(params: {
    key: string;
    contentType: string;
    parts: MultipartPartDeclaration[];
    expiresSeconds: number;
  }): Promise<MultipartUploadPlan> {
    const url = new URL(`${this.requestUrl(params.key).toString()}?uploads=`);
    // CreateMultipartUpload is a signed POST with an empty body; Content-Type
    // is recorded on the eventual object.
    const headers = await this.signedHeaders("POST", url, sha256(""), params.contentType);
    const res = await fetchWithTimeout(url, { method: "POST", headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`S3 CreateMultipartUpload failed (${res.status}): ${body.slice(0, 200)}`);
    const uploadId = body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
    if (!uploadId) throw new Error("S3 CreateMultipartUpload returned no UploadId");

    const expiresAt = new Date(Date.now() + params.expiresSeconds * 1000);
    const targets = await Promise.all(
      params.parts.map(async (part) => {
        const checksumB64 = hexToBase64(part.checksumSha256Hex);
        const partUrl = await this.presignPartUrl({
          key: params.key,
          uploadId,
          partNumber: part.partNumber,
          checksumSha256B64: checksumB64,
          expiresSeconds: params.expiresSeconds,
        });
        return {
          partNumber: part.partNumber,
          method: "PUT" as const,
          url: partUrl,
          headers: { "x-amz-checksum-sha256": checksumB64 },
        };
      })
    );
    return { uploadId, parts: targets, expiresAt };
  }

  async completeMultipartUpload(params: { key: string; uploadId: string; parts: MultipartCompletedPart[] }): Promise<void> {
    const ordered = [...params.parts].sort((a, b) => a.partNumber - b.partNumber);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      ordered.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join("") +
      `</CompleteMultipartUpload>`;
    const url = new URL(`${this.requestUrl(params.key).toString()}?uploadId=${rfc3986(params.uploadId)}`);
    const headers = await this.signedHeaders("POST", url, sha256(xml), "application/xml");
    const res = await fetchWithTimeout(url, { method: "POST", headers, body: xml });
    const respBody = await res.text();
    // S3 can return HTTP 200 with an <Error> body on completion failure — treat
    // that as a failure, never a fabricated success.
    if (!res.ok || /<Error>/.test(respBody)) {
      throw new Error(`S3 CompleteMultipartUpload failed (${res.status}): ${respBody.slice(0, 200)}`);
    }
  }

  async abortMultipartUpload(params: { key: string; uploadId: string }): Promise<void> {
    const url = new URL(`${this.requestUrl(params.key).toString()}?uploadId=${rfc3986(params.uploadId)}`);
    const res = await fetchWithTimeout(url, { method: "DELETE", headers: await this.signedHeaders("DELETE", url, sha256("")) });
    // 404/NoSuchUpload means it was already aborted/completed — not an error.
    if (!res.ok && res.status !== 404) throw new Error(`S3 AbortMultipartUpload failed (${res.status})`);
  }

  /** Query-string SigV4 presign for a single UploadPart PUT. Binds host and
   * the exact per-part checksum as signed headers, so the client must send the
   * declared bytes (checksum) and cannot repoint the request. */
  private async presignPartUrl(params: {
    key: string;
    uploadId: string;
    partNumber: number;
    checksumSha256B64: string;
    expiresSeconds: number;
  }): Promise<string> {
    const creds = await this.credentials();
    const url = this.requestUrl(params.key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const signedHeaderNames = "host;x-amz-checksum-sha256";

    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${creds.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(params.expiresSeconds),
      "X-Amz-SignedHeaders": signedHeaderNames,
      partNumber: String(params.partNumber),
      uploadId: params.uploadId,
    };
    if (creds.sessionToken) query["X-Amz-Security-Token"] = creds.sessionToken;

    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`)
      .join("&");
    const canonicalHeaders = `host:${url.host}\nx-amz-checksum-sha256:${params.checksumSha256B64}\n`;
    const canonicalRequest = ["PUT", url.pathname, canonicalQuery, canonicalHeaders, signedHeaderNames, "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", this.signingKey(creds.secretAccessKey, date)).update(stringToSign).digest("hex");
    return `${url.toString()}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}
