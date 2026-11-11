import { Buffer } from 'node:buffer';
import { Archil, type ArchilOptions, type Disk } from 'disk';
import type { SharedDisk } from '../contracts/types.js';

/** Native object operations publish directly to the shared filesystem. */
export type ArchilDiskLike = Pick<Disk, 'getObject' | 'putObject' | 'listObjects'>;

export interface ArchilDiskSdkLike {
  disks: { get(id: string): Promise<ArchilDiskLike> };
}

export interface ArchilDiskOptions {
  diskId: string;
  region: string;
  /** Required unless an already configured SDK client is injected. */
  apiKey?: string;
  baseUrl?: string;
  s3BaseUrl?: string;
  tls?: ArchilOptions['tls'];
  sdk?: ArchilDiskSdkLike;
}

function objectKey(path: string, prefix = false): string {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new Error('Shared disk paths must be absolute and contain no NUL bytes');
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('Shared disk paths must not contain dot segments');
  }
  const key = segments.filter(Boolean).join('/');
  if (!prefix && (!key || path.endsWith('/'))) {
    throw new Error('Shared disk file paths must name a file');
  }
  return prefix && key && path.endsWith('/') ? `${key}/` : key;
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return ('status' in error && error.status === 404)
    || ('code' in error && error.code === 'NoSuchKey');
}

export function createArchilDisk(opts: ArchilDiskOptions): SharedDisk {
  if (!opts.diskId.trim() || !opts.region.trim()) {
    throw new Error('An Archil disk ID and region are required');
  }
  if (!opts.sdk && !opts.apiKey?.trim()) {
    throw new Error('An Archil API key or configured SDK client is required');
  }
  const sdk = opts.sdk ?? new Archil({
    apiKey: opts.apiKey,
    region: opts.region,
    baseUrl: opts.baseUrl,
    s3BaseUrl: opts.s3BaseUrl,
    tls: opts.tls,
  });
  let pendingDisk: Promise<ArchilDiskLike> | undefined;
  const getDisk = (): Promise<ArchilDiskLike> => {
    // Share metadata lookup across concurrent calls, but allow a failed lookup
    // to be retried by the next operation.
    pendingDisk ??= sdk.disks.get(opts.diskId).catch(error => {
      pendingDisk = undefined;
      throw error;
    });
    return pendingDisk;
  };

  return {
    async write(path, data) {
      const key = objectKey(path);
      const disk = await getDisk();
      // PutObject creates missing parents and resolves after publication; no
      // mounted-client cache or shell-level sync is involved in native writes.
      await disk.putObject(key, data);
    },

    async read(path) {
      const key = objectKey(path);
      const disk = await getDisk();
      try {
        return Buffer.from(await disk.getObject(key)).toString('utf8');
      } catch (error) {
        if (isMissingObject(error)) return undefined;
        throw error;
      }
    },

    async list(prefix) {
      const key = objectKey(prefix, true);
      const disk = await getDisk();
      // The SDK follows all continuation tokens when no limit is supplied.
      const result = await disk.listObjects(key);
      return [...new Set(result.objects
        .filter(object => !object.key.endsWith('/'))
        .map(object => `/${object.key.replace(/^\/+/, '')}`))].sort();
    },
  };
}
