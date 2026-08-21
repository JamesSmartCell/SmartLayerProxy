#!/usr/bin/env node
/**
 * Create R2 API credentials via Cloudflare API
 *
 * The dashboard may only show the Secret Key. This script creates credentials
 * programmatically and prints BOTH Access Key ID and Secret Access Key.
 *
 * Prerequisites:
 * 1. Create an API token at https://dash.cloudflare.com/profile/api-tokens
 *    Use template "Create additional tokens" (or custom with API Tokens:Edit)
 * 2. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy node scripts/create-r2-credentials.js
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = process.env.R2_BUCKET_NAME || 'garage-camera';

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  console.error('');
  console.error('Get API token: Profile → API Tokens → Create Token');
  console.error('  Use template "Create additional tokens"');
  console.error('  Or custom: add "API Tokens" → "Edit"');
  process.exit(1);
}

// Workers R2 Storage Bucket Item Write - allows read/write/list objects in buckets
// Permission group ID from Cloudflare docs
const R2_BUCKET_WRITE_ID = 'f7f0eda5697f475c90846e879bab8665';

async function createR2Token() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens`;
  const body = {
    name: `r2-${BUCKET}-${Date.now()}`,
    policies: [
      {
        effect: 'allow',
        resources: {
          [`com.cloudflare.edge.r2.bucket.${ACCOUNT_ID}_default_${BUCKET}`]: '*',
        },
        permission_groups: [
          { id: R2_BUCKET_WRITE_ID, name: 'Workers R2 Storage Bucket Item Write' },
        ],
      },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.success) {
    console.error('API error:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const result = data.result;
  // R2 tokens return: id (Access Key ID), secret (Secret Access Key)
  const accessKeyId = result.id || result.access_key_id;
  const secretAccessKey = result.secret || result.value;

  if (!accessKeyId || !secretAccessKey) {
    console.error('Unexpected response format:', JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log('');
  console.log('R2 credentials created. Add to your .env:');
  console.log('');
  console.log(`R2_ACCESS_KEY_ID=${accessKeyId}`);
  console.log(`R2_SECRET_ACCESS_KEY=${secretAccessKey}`);
  console.log('');
  console.log('Save the Secret Access Key now - it cannot be retrieved again.');
}

createR2Token().catch((err) => {
  console.error(err);
  process.exit(1);
});
