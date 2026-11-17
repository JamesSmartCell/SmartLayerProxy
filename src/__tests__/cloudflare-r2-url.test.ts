import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutObjectCommand: vi.fn(),
}));

describe('CloudflareR2 URL selection', () => {
  let originalEnv: NodeJS.ProcessEnv;
  
  beforeEach(() => {
    originalEnv = { ...process.env };
    mockSend.mockClear();
    mockSend.mockResolvedValue({});
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('should use R2_FIRMWARE_PUBLIC_URL for firmware uploads when set', async () => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    process.env.R2_FIRMWARE_BUCKET_NAME = 'firmware-bucket';
    process.env.R2_PUBLIC_URL = 'https://camera.r2.dev';
    process.env.R2_FIRMWARE_PUBLIC_URL = 'https://firmware.r2.dev';

    const { uploadToR2, getFirmwareBucketName } = await import('../service/CloudflareR2');

    const url = await uploadToR2(
      'firmware/test/1.0.0/firmware.bin',
      Buffer.from('test'),
      'application/octet-stream',
      getFirmwareBucketName()
    );

    expect(url).toBe('https://firmware.r2.dev/firmware/test/1.0.0/firmware.bin');
  });

  it('should fall back to R2_PUBLIC_URL for firmware when R2_FIRMWARE_PUBLIC_URL is not set', async () => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    process.env.R2_FIRMWARE_BUCKET_NAME = 'firmware-bucket';
    process.env.R2_PUBLIC_URL = 'https://public.r2.dev';
    delete process.env.R2_FIRMWARE_PUBLIC_URL;

    const { uploadToR2, getFirmwareBucketName } = await import('../service/CloudflareR2');

    const url = await uploadToR2(
      'firmware/test/1.0.0/firmware.bin',
      Buffer.from('test'),
      'application/octet-stream',
      getFirmwareBucketName()
    );

    expect(url).toBe('https://public.r2.dev/firmware/test/1.0.0/firmware.bin');
  });

  it('should fall back to cloudflarestorage.com when no public URL is set', async () => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    process.env.R2_FIRMWARE_BUCKET_NAME = 'firmware-bucket';
    delete process.env.R2_PUBLIC_URL;
    delete process.env.R2_FIRMWARE_PUBLIC_URL;

    const { uploadToR2, getFirmwareBucketName } = await import('../service/CloudflareR2');

    const url = await uploadToR2(
      'firmware/test/1.0.0/firmware.bin',
      Buffer.from('test'),
      'application/octet-stream',
      getFirmwareBucketName()
    );

    expect(url).toBe('https://test-account.r2.cloudflarestorage.com/firmware-bucket/firmware/test/1.0.0/firmware.bin');
  });

  it('should trim trailing slashes from public URLs', async () => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    process.env.R2_FIRMWARE_BUCKET_NAME = 'firmware-bucket';
    process.env.R2_FIRMWARE_PUBLIC_URL = 'https://firmware.r2.dev/';

    const { uploadToR2, getFirmwareBucketName } = await import('../service/CloudflareR2');

    const url = await uploadToR2(
      'firmware/test/1.0.0/firmware.bin',
      Buffer.from('test'),
      'application/octet-stream',
      getFirmwareBucketName()
    );

    expect(url).toBe('https://firmware.r2.dev/firmware/test/1.0.0/firmware.bin');
  });

  it('should use R2_PUBLIC_URL for camera uploads (unchanged behavior)', async () => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    process.env.R2_FIRMWARE_BUCKET_NAME = 'firmware-bucket';
    process.env.R2_PUBLIC_URL = 'https://camera.r2.dev';
    process.env.R2_FIRMWARE_PUBLIC_URL = 'https://firmware.r2.dev';

    const { uploadToR2 } = await import('../service/CloudflareR2');

    const url = await uploadToR2(
      'camera/request-123.jpg',
      Buffer.from('test'),
      'image/jpeg'
    );

    expect(url).toBe('https://camera.r2.dev/camera/request-123.jpg');
  });

  it('should log warning once when firmware bucket is set but no public URL configured', async () => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    process.env.R2_FIRMWARE_BUCKET_NAME = 'firmware-bucket';
    delete process.env.R2_PUBLIC_URL;
    delete process.env.R2_FIRMWARE_PUBLIC_URL;

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    const { uploadToR2, getFirmwareBucketName } = await import('../service/CloudflareR2');

    await uploadToR2(
      'firmware/test/1.0.0/firmware.bin',
      Buffer.from('test'),
      'application/octet-stream',
      getFirmwareBucketName()
    );

    await uploadToR2(
      'firmware/test/1.0.1/firmware.bin',
      Buffer.from('test'),
      'application/octet-stream',
      getFirmwareBucketName()
    );

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('R2_FIRMWARE_BUCKET_NAME is set but neither R2_FIRMWARE_PUBLIC_URL nor R2_PUBLIC_URL is configured')
    );
    
    consoleWarnSpy.mockRestore();
  });

  it('should not log warning when firmware bucket equals camera bucket', async () => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'shared-bucket';
    delete process.env.R2_FIRMWARE_BUCKET_NAME;
    delete process.env.R2_PUBLIC_URL;
    delete process.env.R2_FIRMWARE_PUBLIC_URL;

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    const { uploadToR2, getFirmwareBucketName } = await import('../service/CloudflareR2');

    await uploadToR2(
      'firmware/test/1.0.0/firmware.bin',
      Buffer.from('test'),
      'application/octet-stream',
      getFirmwareBucketName()
    );

    const warningCalls = consoleWarnSpy.mock.calls.filter(call => 
      call[0]?.includes?.('R2_FIRMWARE_BUCKET_NAME')
    );
    expect(warningCalls).toHaveLength(0);
    
    consoleWarnSpy.mockRestore();
  });
});
