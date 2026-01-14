import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { type Logger } from "pino";
import { CacheBackend } from "./cache";

// AWS Systems Manager Parameter Store backend for production
export class ParameterStoreBackend implements CacheBackend {
  private parameterName: string;
  private ssmClient: SSMClient;
  private logger: Logger;

  constructor(parameterName: string, logger: Logger) {
    this.parameterName = parameterName;
    this.ssmClient = new SSMClient({});
    this.logger = logger;
  }

  async load(): Promise<Map<string, any>> {
    try {
      const command = new GetParameterCommand({
        Name: this.parameterName,
      });
      const response = await this.ssmClient.send(command);
      if (response.Parameter?.Value) {
        const entries = JSON.parse(response.Parameter.Value);
        return new Map(entries);
      }
    } catch (error: any) {
      // ParameterNotFound is expected on first run
      if (error.name !== "ParameterNotFound") {
        this.logger.warn(
          { error, parameterName: this.parameterName },
          "Failed to load cache from Parameter Store"
        );
      }
    }
    return new Map();
  }

  async save(entries: Array<[string, any]>): Promise<void> {
    try {
      const data = JSON.stringify(entries);
      const command = new PutParameterCommand({
        Name: this.parameterName,
        Value: data,
        Type: "String",
        Overwrite: true,
      });
      await this.ssmClient.send(command);
    } catch (error) {
      this.logger.error(
        { error, parameterName: this.parameterName },
        "Failed to save cache to Parameter Store"
      );
    }
  }
}
