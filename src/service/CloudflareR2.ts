/**
 * Cloudflare R2 upload service
 * Uses S3-compatible API with presigned URLs or direct upload
 *
 * Set env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *   R2_PUBLIC_URL (e.g. https://pub-xxx.r2.dev or custom domain)
 *   R2_FIRMWARE_BUCKET_NAME (optional, defaults to R2_BUCKET_NAME)
 *   R2_FIRMWARE_PUBLIC_URL (optional, public URL for firmware bucket)
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const accountId = process.env.R2_ACCOUNT_ID || '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const bucketName = process.env.R2_BUCKET_NAME || 'garage-camera';
const firmwareBucketName = process.env.R2_FIRMWARE_BUCKET_NAME || bucketName;
const publicBaseUrl = process.env.R2_PUBLIC_URL || ''; // e.g. https://pub-xxx.r2.dev
const firmwarePublicBaseUrl = process.env.R2_FIRMWARE_PUBLIC_URL || '';

let s3Client: S3Client | null = null;
let hasLoggedFirmwareUrlWarning = false;

function getClient(): S3Client | null {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.warn('[R2] Missing credentials - set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
    return null;
  }
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return s3Client;
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
        Bucket: bucketName,
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

/**
 * Upload buffer to R2 and return public URL
 * @param key - Object key in R2
 * @param body - Buffer to upload
 * @param contentType - MIME type (default: 'image/jpeg' for backward compatibility with camera uploads)
 * @param bucket - Optional bucket override (defaults to R2_BUCKET_NAME)
 * @param publicBaseUrlOverride - Optional public base URL override for this upload
 */
export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType = 'image/jpeg',
  bucket?: string,
  publicBaseUrlOverride?: string
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  const targetBucket = bucket || bucketName;
  
  if (targetBucket === firmwareBucketName && firmwareBucketName !== bucketName) {
    if (!hasLoggedFirmwareUrlWarning && !firmwarePublicBaseUrl && !publicBaseUrl) {
      console.warn('[R2] Warning: R2_FIRMWARE_BUCKET_NAME is set but neither R2_FIRMWARE_PUBLIC_URL nor R2_PUBLIC_URL is configured. Devices will not be able to download firmware from the private storage endpoint.');
      hasLoggedFirmwareUrlWarning = true;
    }
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
    
    const effectivePublicUrl = publicBaseUrlOverride 
      || (targetBucket === firmwareBucketName ? firmwarePublicBaseUrl : '')
      || publicBaseUrl;
    
    if (effectivePublicUrl) {
      const base = effectivePublicUrl.replace(/\/$/, '');
      return `${base}/${key}`;
    }
    return `https://${accountId}.r2.cloudflarestorage.com/${targetBucket}/${key}`;
  } catch (err) {
    console.error('[R2] Upload error:', err);
    return null;
  }
}

export function isR2Configured(): boolean {
  return !!(accountId && accessKeyId && secretAccessKey);
}

export function getFirmwareBucketName(): string {
  return firmwareBucketName;
}
