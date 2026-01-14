import "dotenv/config";
import { Type, Static } from "@sinclair/typebox";
import Ajv from "ajv";

const schema = Type.Object({
  HASHRATE_ORACLE_ADDRESS: Type.String(),
  CHAIN_ID: Type.Integer(),
  ETHEREUM_RPC_URL: Type.String(),
  BITCOIN_RPC_URL: Type.String(),
  // PRIVATE_KEY can be:
  // - An actual private key (0x123...) for local development
  // - A Secrets Manager ARN (arn:aws:secretsmanager:...) for Lambda - retrieved at runtime
  PRIVATE_KEY: Type.String(),
  CACHE_PARAMETER_NAME: Type.Optional(Type.String()),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal("trace"),
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
      Type.Literal("fatal"),
    ],
    { default: "info" }
  ),
  BTCUSD_ORACLE_ADDRESS: Type.Optional(Type.String()),
});

const ajv = new Ajv({ coerceTypes: true, allErrors: true });
const validate = ajv.compile(schema);

const success = validate(process.env);

if (!success) {
  throw new Error(
    "Invalid environment variables:\n" +
      validate.errors
        ?.map((e) => `${e.instancePath}: ${e.message} ${e.params?.allowedValue || ""}`)
        .join("\n")
  );
}

export type Config = Static<typeof schema>;
export const env = process.env as unknown as Config;
