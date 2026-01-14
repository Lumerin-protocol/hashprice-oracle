import { main } from "./src/job";

export const handler = async (): Promise<void> => {
  await main();
};
