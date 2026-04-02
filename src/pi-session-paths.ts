import { closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";

import { expandHomePath } from "./paths.js";

interface SessionHeaderInfo {
  id: string;
  cwd?: string;
}

export function resolveSessionPathForRuntime(sessionPath: string): string {
  const expandedPath = expandHomePath(sessionPath);
  if (existsSync(expandedPath)) {
    return expandedPath;
  }

  // Remap host paths to container paths (e.g. /Users/<user>/.pi/agent/... → /home/telepi/.pi/agent/...)
  const marker = `${path.sep}.pi${path.sep}agent${path.sep}`;
  const markerIndex = expandedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return expandedPath;
  }

  const suffix = expandedPath.slice(markerIndex + marker.length);
  for (const base of ["/home/telepi/.pi/agent", "/root/.pi/agent"]) {
    const remapped = path.resolve(base, suffix);
    // Ensure remapped path stays within the base directory (prevent traversal)
    if (!remapped.startsWith(base + path.sep) && remapped !== base) {
      continue;
    }
    if (existsSync(remapped)) {
      return remapped;
    }
  }

  return expandedPath;
}

export function readSessionHeader(sessionPath: string): SessionHeaderInfo | undefined {
  try {
    const fd = openSync(sessionPath, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]?.trim();
      if (!firstLine) {
        return undefined;
      }

      const parsed = JSON.parse(firstLine) as { type?: string; id?: unknown; cwd?: unknown };
      if (parsed.type !== "session" || typeof parsed.id !== "string") {
        return undefined;
      }

      return {
        id: parsed.id,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function resolveWorkspacePathForRuntime(workspace: string | undefined): string | undefined {
  if (!workspace) {
    return undefined;
  }

  if (existsSync(workspace)) {
    return workspace;
  }

  return undefined;
}
