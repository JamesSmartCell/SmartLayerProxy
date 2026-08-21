/**
 * Cloudflare R2 upload service
 * Uses S3-compatible API with presigned URLs or direct upload
 *
 * Set env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *   R2_PUBLIC_URL (e.g. https://pub-xxx.r2.dev or custom domain)
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const accountId = process.env.R2_ACCOUNT_ID || '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const bucketName = process.env.R2_BUCKET_NAME || 'garage-camera';
const publicBaseUrl = process.env.R2_PUBLIC_URL || ''; // e.g. https://pub-xxx.r2.dev

let s3Client: S3Client | null = null;

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
 */
export async function uploadToR2(key: string, body: Buffer): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: 'image/jpeg',
      })
    );
    if (publicBaseUrl) {
      const base = publicBaseUrl.replace(/\/$/, '');
      return `${base}/${key}`;
    }
    return `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${key}`;
  } catch (err) {
    console.error('[R2] Upload error:', err);
    return null;
  }
}

export function isR2Configured(): boolean {
  return !!(accountId && accessKeyId && secretAccessKey);
}
