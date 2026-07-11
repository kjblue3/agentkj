import path from "node:path";

export function stateFilePath(
  filename: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  const configuredDirectory = env.STATE_DIR?.trim();
  const directory = configuredDirectory
    ? path.resolve(cwd, configuredDirectory)
    : path.resolve(cwd, "data");
  return path.join(directory, filename);
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return path.resolve(cwd, env.STATE_DIR?.trim() || "data");
}
