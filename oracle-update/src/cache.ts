/**
 * FileCache - A persistent cache with support for both file system and AWS Parameter Store
 *
 * Usage:
 * - Local development: new FileCache(500) - uses .cache.json file
 * - AWS Lambda: new FileCache(500, { parameterName: '/myapp/cache', useParameterStore: true })
 *
 * For AWS Lambda, set AWS_REGION environment variable and provide parameterName.
 * The cache automatically uses Parameter Store if AWS_REGION is set and parameterName is provided.
 *
 * AWS Parameter Store is ideal for Lambda cron jobs:
 * - Free tier: 10,000 standard parameters, 4KB each
 * - Entire cache stored as single JSON parameter (<50KB for 500 entries)
 * - Persistent across Lambda invocations
 * - No infrastructure to manage
 */

import * as path from "path";
import pino, { type Logger } from "pino";
import { ParameterStoreBackend } from "./cache-ssm";
import { FileSystemBackend } from "./cache-filesystem";

// Cache backend interface
export interface CacheBackend {
  load(): Promise<Map<string, any>>;
  save(entries: Array<[string, any]>): Promise<void>;
}

// File system backend for local development

export class FileCache {
  private cache: Map<string, any> = new Map();
  private maxSize: number;
  private backend: CacheBackend;
  private savePending: boolean = false;
  private loadPromise: Promise<void>;
  private logger: Logger;

  constructor(
    maxSize: number,
    options?: {
      cacheFilePath?: string;
      parameterName?: string;
      useParameterStore?: boolean;
      logger?: Logger;
    }
  ) {
    this.maxSize = maxSize;
    // Create a silent logger if none provided (for backward compatibility)
    this.logger = options?.logger || this.createSilentLogger();

    // Determine backend based on environment or options
    const useParameterStore = options?.useParameterStore ?? process.env.AWS_REGION !== undefined;

    if (useParameterStore && options?.parameterName) {
      this.backend = new ParameterStoreBackend(options.parameterName, this.logger);
    } else {
      const cacheFilePath = options?.cacheFilePath || path.join(process.cwd(), ".cache.json");
      this.backend = new FileSystemBackend(cacheFilePath, this.logger);
    }

    // Load cache asynchronously - don't block constructor
    this.loadPromise = this.load();
  }

  private createSilentLogger(): Logger {
    // Create a silent logger for backward compatibility when no logger is provided
    return pino({ level: "silent" });
  }

  private async load(): Promise<void> {
    this.cache = await this.backend.load();
  }

  // Optional: await this if you need to ensure cache is loaded before use
  async ready(): Promise<void> {
    await this.loadPromise;
  }

  public async save(): Promise<void> {
    // Debounce saves to avoid excessive writes
    if (this.savePending) {
      return;
    }

    this.savePending = true;
    // Use setImmediate to batch multiple rapid updates
    setImmediate(async () => {
      try {
        const entries = Array.from(this.cache.entries());
        await this.backend.save(entries);
      } finally {
        this.savePending = false;
      }
    });
  }

  get(key: string) {
    return this.cache.get(key);
  }

  set(key: string, value: any): void {
    // If cache is at max size and key doesn't exist, remove oldest entry
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, value);
  }

  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  clear(): void {
    this.cache.clear();
    this.save();
  }
}
