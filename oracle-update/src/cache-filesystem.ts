import * as fs from "fs";
import type { Logger } from "pino";
import { CacheBackend } from "./cache";

export class FileSystemBackend implements CacheBackend {
  private cacheFilePath: string;
  private logger: Logger;

  constructor(cacheFilePath: string, logger: Logger) {
    this.cacheFilePath = cacheFilePath;
    this.logger = logger;
  }

  async load(): Promise<Map<string, any>> {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const data = fs.readFileSync(this.cacheFilePath, "utf-8");
        const entries = JSON.parse(data);
        return new Map(entries);
      }
    } catch (error) {
      this.logger.warn(
        { error, cacheFilePath: this.cacheFilePath },
        "Failed to load cache from file"
      );
    }
    return new Map();
  }

  async save(entries: Array<[string, any]>): Promise<void> {
    try {
      const data = JSON.stringify(entries, null, 2);
      fs.writeFileSync(this.cacheFilePath, data, "utf-8");
    } catch (error) {
      this.logger.error(
        { error, cacheFilePath: this.cacheFilePath },
        "Failed to save cache to file"
      );
    }
  }
}
