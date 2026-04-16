import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { TaskArguments } from "hardhat/types/tasks";

export default async function (
  args: TaskArguments,
  _hre: HardhatRuntimeEnvironment,
  runSuper: (args: TaskArguments) => Promise<unknown>,
): Promise<void> {
  await runSuper(args);
  const { main } = await import("./export-abi.ts");
  main();
}
