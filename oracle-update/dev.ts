import { main } from "./src/job";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
