/**
 * Cloudflare R2 upload service
 * Uses S3-compatible API with presigned URLs or direct upload
 *
 * Global env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *   R2_PUBLIC_URL (e.g. https://pub-xxx.r2.dev or custom domain)
 *   R2_FIRMWARE_BUCKET_NAME (optional global firmware default, falls back to R2_BUCKET_NAME)
 *   R2_FIRMWARE_PUBLIC_URL (optional global firmware public URL)
 *
 * Per-project firmware overrides (project "zigbee-gateway" → suffix ZIGBEE_GATEWAY):
 *   R2_FIRMWARE_BUCKET_NAME__ZIGBEE_GATEWAY
 *   R2_FIRMWARE_PUBLIC_URL__ZIGBEE_GATEWAY
 *   R2_ACCESS_KEY_ID__ZIGBEE_GATEWAY / R2_SECRET_ACCESS_KEY__ZIGBEE_GATEWAY (optional)
 *   R2_ACCOUNT_ID__ZIGBEE_GATEWAY (optional)
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface FirmwareStorageConfig {
  project?: string;
  bucket: string;
  publicUrl: string;
  credentials: R2Credentials;
  /** True when bucket differs from the camera/default bucket. */
  isDedicatedFirmwareBucket: boolean;
}

const clientCache = new Map<string, S3Client>();
const warnedProjects = new Set<string>();

function env(name: string): string {
  return (process.env[name] || '').trim();
}

function defaultBucketName(): string {
  return env('R2_BUCKET_NAME') || 'garage-camera';
}

function globalFirmwareBucketName(): string {
  return env('R2_FIRMWARE_BUCKET_NAME') || defaultBucketName();
}

function globalFirmwarePublicUrl(): string {
  return env('R2_FIRMWARE_PUBLIC_URL') || '';
}

function globalPublicUrl(): string {
  return env('R2_PUBLIC_URL') || '';
}

function globalCredentials(): R2Credentials {
  return {
    accountId: env('R2_ACCOUNT_ID'),
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  };
}

/**
 * Map a firmware project name to an env-var suffix.
 * e.g. "zigbee-gateway" → "ZIGBEE_GATEWAY", "GarageDoor" → "GARAGEDOOR"
 */
export function projectToEnvSuffix(project: string): string {
  return project
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function projectEnv(base: string, project: string | undefined): string {
  if (!project) return '';
  const suffix = projectToEnvSuffix(project);
  if (!suffix) return '';
  return env(`${base}__${suffix}`);
}

/**
 * Resolve bucket, public URL, and credentials for a firmware project.
 * Fallback order: per-project override → global firmware defaults → camera/default bucket.
 * Existing R2_FIRMWARE_BUCKET_NAME / R2_FIRMWARE_PUBLIC_URL remain global defaults
 * and are not repurposed.
 */
export function getFirmwareStorageConfig(project?: string): FirmwareStorageConfig {
  const cameraBucket = defaultBucketName();
  const bucket =
    projectEnv('R2_FIRMWARE_BUCKET_NAME', project) ||
    globalFirmwareBucketName();

  const publicUrl =
    projectEnv('R2_FIRMWARE_PUBLIC_URL', project) ||
    globalFirmwarePublicUrl() ||
    globalPublicUrl();

  const globals = globalCredentials();
  const credentials: R2Credentials = {
    accountId: projectEnv('R2_ACCOUNT_ID', project) || globals.accountId,
    accessKeyId: projectEnv('R2_ACCESS_KEY_ID', project) || globals.accessKeyId,
    secretAccessKey: projectEnv('R2_SECRET_ACCESS_KEY', project) || globals.secretAccessKey,
  };

  return {
    project,
    bucket,
    publicUrl,
    credentials,
    isDedicatedFirmwareBucket: bucket !== cameraBucket,
  };
}

/** @deprecated Prefer getFirmwareStorageConfig(project). Kept for callers/tests. */
export function getFirmwareBucketName(project?: string): string {
  return getFirmwareStorageConfig(project).bucket;
}

function clientCacheKey(creds: R2Credentials): string {
  return `${creds.accountId}|${creds.accessKeyId}|${creds.secretAccessKey}`;
}

function getClient(creds?: R2Credentials): S3Client | null {
  const resolved = creds || globalCredentials();
  if (!resolved.accountId || !resolved.accessKeyId || !resolved.secretAccessKey) {
    console.warn('[R2] Missing credentials - set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
    return null;
  }

  const key = clientCacheKey(resolved);
  let client = clientCache.get(key);
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${resolved.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: resolved.accessKeyId,
        secretAccessKey: resolved.secretAccessKey,
      },
    });
    clientCache.set(key, client);
  }
  return client;
}

function maybeWarnMissingFirmwarePublicUrl(config: FirmwareStorageConfig): void {
  if (!config.isDedicatedFirmwareBucket) return;
  if (config.publicUrl) return;

  const warnKey = config.project ? projectToEnvSuffix(config.project) : '__global__';
  if (warnedProjects.has(warnKey)) return;
  warnedProjects.add(warnKey);

  const projectHint = config.project
    ? ` for project "${config.project}" (also check R2_FIRMWARE_PUBLIC_URL__${projectToEnvSuffix(config.project)})`
    : '';
  console.warn(
    `[R2] Warning: firmware bucket "${config.bucket}" is set but neither R2_FIRMWARE_PUBLIC_URL nor R2_PUBLIC_URL is configured${projectHint}. Devices will not be able to download firmware from the private storage endpoint.`
  );
}

/**
 * Generate a presigned PUT URL for the camera to upload directly
 */
export async function createPresignedUploadUrl(key: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: defaultBucketName(),
        Key: key,
        ContentType: 'image/jpeg',
      }),
      { expiresIn: 300 } // 5 min
    );
    return url;
  } catch (err) {
    console.error('[R2] Presign error:', err);
    return null;
  }
}

function buildPublicObjectUrl(
  key: string,
  bucket: string,
  publicBaseUrl: string,
  accountId: string
): string {
  if (publicBaseUrl) {
    const base = publicBaseUrl.replace(/\/$/, '');
    return `${base}/${key}`;
  }
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

/**
 * Upload buffer to R2 and return public URL
 * @param key - Object key in R2
 * @param body - Buffer to upload
 * @param contentType - MIME type (default: 'image/jpeg' for backward compatibility with camera uploads)
 * @param bucket - Optional bucket override (defaults to R2_BUCKET_NAME)
 * @param publicBaseUrlOverride - Optional public base URL override for this upload
 * @param credentials - Optional credentials (for per-bucket scoped tokens)
 */
export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType = 'image/jpeg',
  bucket?: string,
  publicBaseUrlOverride?: string,
  credentials?: R2Credentials
): Promise<string | null> {
  const creds = credentials || globalCredentials();
  const client = getClient(creds);
  if (!client) return null;

  const targetBucket = bucket || defaultBucketName();
  const cameraBucket = defaultBucketName();
  const firmwareBucket = globalFirmwareBucketName();

  if (targetBucket === firmwareBucket && firmwareBucket !== cameraBucket) {
    maybeWarnMissingFirmwarePublicUrl({
      bucket: targetBucket,
      publicUrl: publicBaseUrlOverride || globalFirmwarePublicUrl() || globalPublicUrl(),
      credentials: creds,
      isDedicatedFirmwareBucket: true,
    });
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: targetBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );

    const effectivePublicUrl =
      publicBaseUrlOverride ||
      (targetBucket === firmwareBucket ? globalFirmwarePublicUrl() : '') ||
      globalPublicUrl();

    return buildPublicObjectUrl(key, targetBucket, effectivePublicUrl, creds.accountId);
  } catch (err) {
    console.error('[R2] Upload error:', err);
    return null;
  }
}

/**
 * Upload firmware for a named project using per-project bucket/URL/credential overrides.
 */
export async function uploadFirmwareToR2(
  project: string,
  key: string,
  body: Buffer
): Promise<string | null> {
  const config = getFirmwareStorageConfig(project);
  maybeWarnMissingFirmwarePublicUrl(config);

  const client = getClient(config.credentials);
  if (!client) return null;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
      })
    );

    return buildPublicObjectUrl(
      key,
      config.bucket,
      config.publicUrl,
      config.credentials.accountId
    );
  } catch (err) {
    console.error('[R2] Firmware upload error:', err);
    return null;
  }
}

export function isR2Configured(project?: string): boolean {
  const creds = project ? getFirmwareStorageConfig(project).credentials : globalCredentials();
  return !!(creds.accountId && creds.accessKeyId && creds.secretAccessKey);
}

/** Test helper: clear cached S3 clients and warning state. */
export function resetR2ClientCache(): void {
  clientCache.clear();
  warnedProjects.clear();
}
