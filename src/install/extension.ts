import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import type { ExtensionStatus, TelePiInstallContext } from "./shared.js";

export function installExtension(context: TelePiInstallContext): "symlink" | "copy" {
  const destinationPath = context.extensionDestinationPath;
  const existingStatus = getExtensionStatus(context);

  if (existingStatus.mode === "symlink" && existingStatus.targetPath === context.extensionSourcePath) {
    return "symlink";
  }

  rmSync(destinationPath, { force: true, recursive: true });

  try {
    symlinkSync(context.extensionSourcePath, destinationPath);
    return "symlink";
  } catch {
    copyFileSync(context.extensionSourcePath, destinationPath);
    return "copy";
  }
}

export function getExtensionStatus(context: TelePiInstallContext): ExtensionStatus {
  const destinationPath = context.extensionDestinationPath;
  const sourcePath = context.extensionSourcePath;

  if (!existsSync(destinationPath)) {
    return {
      exists: false,
      mode: "missing",
      detail: "missing",
      targetPath: undefined,
    };
  }

  const stats = lstatSync(destinationPath);
  if (stats.isSymbolicLink()) {
    const rawTarget = readlinkSync(destinationPath);
    const resolvedTarget = path.resolve(path.dirname(destinationPath), rawTarget);
    if (resolvedTarget === sourcePath) {
      return {
        exists: true,
        mode: "symlink",
        detail: "symlinked",
        targetPath: resolvedTarget,
      };
    }

    return {
      exists: true,
      mode: "custom",
      detail: "symlinked elsewhere",
      targetPath: resolvedTarget,
    };
  }

  if (filesMatch(destinationPath, sourcePath)) {
    return {
      exists: true,
      mode: "copy",
      detail: "copied",
      targetPath: undefined,
    };
  }

  return {
    exists: true,
    mode: "custom",
    detail: "custom file",
    targetPath: undefined,
  };
}

function filesMatch(leftPath: string, rightPath: string): boolean {
  if (!existsSync(leftPath) || !existsSync(rightPath)) {
    return false;
  }

  return readFileSync(leftPath, "utf8") === readFileSync(rightPath, "utf8");
}
