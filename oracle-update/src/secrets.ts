import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { env } from "./env";
import pino from "pino";

const client = new SecretsManagerClient();

/**
 * Retrieves the oracle private key, supporting both local development and Lambda deployment.
 * 
 * This function intelligently detects whether PRIVATE_KEY contains:
 * - An actual private key (0x123...) - returns it directly (local dev)
 * - A Secrets Manager ARN (arn:aws:secretsmanager:...) - retrieves from AWS (Lambda)
 * 
 * This approach maintains backward compatibility and requires zero changes to existing developer workflows.
 * 
 * @param logger - Optional pino logger for debug output
 * @returns The oracle private key as a hex string (0x...)
 * @throws Error if the secret cannot be retrieved or parsed
 */
export async function getPrivateKey(logger?: pino.Logger): Promise<string> {
  const privateKeyValue = env.PRIVATE_KEY;

  // Detect if PRIVATE_KEY is a Secrets Manager ARN
  if (privateKeyValue.startsWith("arn:aws:secretsmanager:")) {
    // Lambda mode: Retrieve from Secrets Manager
    logger?.debug("PRIVATE_KEY is a Secrets Manager ARN, retrieving secret at runtime");
    
    try {
      const response = await client.send(
        new GetSecretValueCommand({
          SecretId: privateKeyValue,
        })
      );

      if (!response.SecretString) {
        throw new Error("Secret value is empty");
      }

      const secret = JSON.parse(response.SecretString);
      
      if (!secret.oracle_private_key) {
        throw new Error("Secret does not contain 'oracle_private_key' field");
      }

      logger?.debug("Successfully retrieved private key from Secrets Manager");
      return secret.oracle_private_key;
      
    } catch (error) {
      logger?.error("Failed to retrieve private key from Secrets Manager: %s", error);
      throw new Error(`Failed to retrieve private key from Secrets Manager: ${error}`);
    }
  }

  // Local dev mode: Use the key directly
  logger?.debug("Using PRIVATE_KEY directly from environment (local development mode)");
  return privateKeyValue;
}

