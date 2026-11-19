import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSend = vi.fn();
const mockS3Client = vi.fn().mockImplementation(() => ({
  send: mockSend,
}));
const mockPutObjectCommand = vi.fn().mockImplementation((input) => input);

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: mockS3Client,
  PutObjectCommand: mockPutObjectCommand,
}));

describe('CloudflareR2 URL selection', () => {
  let originalEnv: NodeJS.ProcessEnv;
  
  beforeEach(() => {
    originalEnv = { ...process.env };
    mockSend.mockClear();
    mockSend.mockResolvedValue({});
    mockS3Client.mockClear();
    mockPutObjectCommand.mockClear();
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
      expect.stringContaining('neither R2_FIRMWARE_PUBLIC_URL nor R2_PUBLIC_URL is configured')
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
      typeof call[0] === 'string' && call[0].includes('neither R2_FIRMWARE_PUBLIC_URL nor R2_PUBLIC_URL')
    );
    expect(warningCalls).toHaveLength(0);
    
    consoleWarnSpy.mockRestore();
  });
});

describe('CloudflareR2 per-project firmware buckets', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockSend.mockClear();
    mockSend.mockResolvedValue({});
    mockS3Client.mockClear();
    mockPutObjectCommand.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  function setBaseEnv(): void {
    process.env.R2_ACCOUNT_ID = 'acct-global';
    process.env.R2_ACCESS_KEY_ID = 'key-global';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-global';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    process.env.R2_PUBLIC_URL = 'https://camera.r2.dev';
    process.env.R2_FIRMWARE_BUCKET_NAME = 'global-firmware';
    process.env.R2_FIRMWARE_PUBLIC_URL = 'https://global-firmware.r2.dev';
  }

  it('maps zigbee-gateway project to ZIGBEE_GATEWAY env suffix', async () => {
    const { projectToEnvSuffix } = await import('../service/CloudflareR2');
    expect(projectToEnvSuffix('zigbee-gateway')).toBe('ZIGBEE_GATEWAY');
    expect(projectToEnvSuffix('GarageDoor')).toBe('GARAGEDOOR');
  });

  it('uses per-project bucket and public URL for zigbee-gateway', async () => {
    setBaseEnv();
    process.env.R2_FIRMWARE_BUCKET_NAME__ZIGBEE_GATEWAY = 'esp-firmware';
    process.env.R2_FIRMWARE_PUBLIC_URL__ZIGBEE_GATEWAY =
      'https://pub-862b54f8a0134f8d8276f74732be8015.r2.dev';

    const { uploadFirmwareToR2, getFirmwareStorageConfig } = await import('../service/CloudflareR2');

    const config = getFirmwareStorageConfig('zigbee-gateway');
    expect(config.bucket).toBe('esp-firmware');
    expect(config.publicUrl).toBe('https://pub-862b54f8a0134f8d8276f74732be8015.r2.dev');

    const url = await uploadFirmwareToR2(
      'zigbee-gateway',
      'firmware/zigbee-gateway/1.0.1/firmware.bin',
      Buffer.from('bin')
    );

    expect(url).toBe(
      'https://pub-862b54f8a0134f8d8276f74732be8015.r2.dev/firmware/zigbee-gateway/1.0.1/firmware.bin'
    );
    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'esp-firmware',
        Key: 'firmware/zigbee-gateway/1.0.1/firmware.bin',
      })
    );
  });

  it('falls back to global firmware defaults for other projects (GarageDoor unchanged)', async () => {
    setBaseEnv();
    process.env.R2_FIRMWARE_BUCKET_NAME__ZIGBEE_GATEWAY = 'esp-firmware';
    process.env.R2_FIRMWARE_PUBLIC_URL__ZIGBEE_GATEWAY =
      'https://pub-862b54f8a0134f8d8276f74732be8015.r2.dev';

    const { uploadFirmwareToR2, getFirmwareStorageConfig } = await import('../service/CloudflareR2');

    const config = getFirmwareStorageConfig('GarageDoor');
    expect(config.bucket).toBe('global-firmware');
    expect(config.publicUrl).toBe('https://global-firmware.r2.dev');

    const url = await uploadFirmwareToR2(
      'GarageDoor',
      'firmware/GarageDoor/1.2.3/firmware.bin',
      Buffer.from('bin')
    );

    expect(url).toBe('https://global-firmware.r2.dev/firmware/GarageDoor/1.2.3/firmware.bin');
    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'global-firmware',
        Key: 'firmware/GarageDoor/1.2.3/firmware.bin',
      })
    );
  });

  it('does not repurpose global R2_FIRMWARE_* when only per-project vars are set', async () => {
    process.env.R2_ACCOUNT_ID = 'acct-global';
    process.env.R2_ACCESS_KEY_ID = 'key-global';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-global';
    process.env.R2_BUCKET_NAME = 'camera-bucket';
    delete process.env.R2_FIRMWARE_BUCKET_NAME;
    delete process.env.R2_FIRMWARE_PUBLIC_URL;
    process.env.R2_FIRMWARE_BUCKET_NAME__ZIGBEE_GATEWAY = 'esp-firmware';
    process.env.R2_FIRMWARE_PUBLIC_URL__ZIGBEE_GATEWAY =
      'https://pub-862b54f8a0134f8d8276f74732be8015.r2.dev';

    const { getFirmwareStorageConfig } = await import('../service/CloudflareR2');

    // GarageDoor keeps camera/default bucket — global firmware vars untouched/unset
    expect(getFirmwareStorageConfig('GarageDoor').bucket).toBe('camera-bucket');
    expect(getFirmwareStorageConfig('zigbee-gateway').bucket).toBe('esp-firmware');
  });

  it('supports per-project bucket-scoped credentials', async () => {
    setBaseEnv();
    process.env.R2_FIRMWARE_BUCKET_NAME__ZIGBEE_GATEWAY = 'esp-firmware';
    process.env.R2_FIRMWARE_PUBLIC_URL__ZIGBEE_GATEWAY =
      'https://pub-862b54f8a0134f8d8276f74732be8015.r2.dev';
    process.env.R2_ACCESS_KEY_ID__ZIGBEE_GATEWAY = 'key-zigbee';
    process.env.R2_SECRET_ACCESS_KEY__ZIGBEE_GATEWAY = 'secret-zigbee';
    process.env.R2_ACCOUNT_ID__ZIGBEE_GATEWAY = 'acct-zigbee';

    const { uploadFirmwareToR2, getFirmwareStorageConfig } = await import('../service/CloudflareR2');

    const config = getFirmwareStorageConfig('zigbee-gateway');
    expect(config.credentials).toEqual({
      accountId: 'acct-zigbee',
      accessKeyId: 'key-zigbee',
      secretAccessKey: 'secret-zigbee',
    });

    await uploadFirmwareToR2(
      'zigbee-gateway',
      'firmware/zigbee-gateway/1.0.1/firmware.bin',
      Buffer.from('bin')
    );

    expect(mockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://acct-zigbee.r2.cloudflarestorage.com',
        credentials: {
          accessKeyId: 'key-zigbee',
          secretAccessKey: 'secret-zigbee',
        },
      })
    );
  });
});
