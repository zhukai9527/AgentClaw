/**
 * Workspace state management — persisted in config.json
 */

import { loadConfig, saveConfig, type AppConfig } from "./config.js";

export interface TargetProject {
  /** Directory name (e.g. "project-a") */
  name: string;
  /** Absolute path to the project directory */
  path: string;
  /** Git remote URL (if cloned) */
  remoteUrl?: string;
  /** Current branch */
  branch?: string;
}

export interface WorkspaceState {
  /** Absolute path to the current workspace directory */
  activeWorkspacePath?: string;
  /** Target business projects imported into workspace/target/ */
  targetProjects: TargetProject[];
  /** Last active task ID */
  lastActiveTaskId?: string;
}

/** Read workspace state from config */
export function loadWorkspaceState(): WorkspaceState {
  const cfg = loadConfig();
  return {
    activeWorkspacePath: (cfg as any).workspacePath || undefined,
    targetProjects: (cfg as any).targetProjects || [],
    lastActiveTaskId: (cfg as any).lastActiveTaskId || undefined,
  };
}

/** Save workspace state to config.json */
export function saveWorkspaceState(state: WorkspaceState): void {
  const patch: Record<string, unknown> = {};
  if (state.activeWorkspacePath !== undefined) {
    patch.workspacePath = state.activeWorkspacePath;
  }
  if (state.targetProjects !== undefined) {
    patch.targetProjects = state.targetProjects;
  }
  if (state.lastActiveTaskId !== undefined) {
    patch.lastActiveTaskId = state.lastActiveTaskId;
  }
  saveConfig(patch as Partial<AppConfig>);
}

/** Set the active workspace path */
export function setActiveWorkspace(path: string): void {
  const state = loadWorkspaceState();
  state.activeWorkspacePath = path;
  saveWorkspaceState(state);
}

/** Add a target project */
export function addTargetProject(project: TargetProject): void {
  const state = loadWorkspaceState();
  const existing = state.targetProjects.findIndex((p) => p.name === project.name);
  if (existing >= 0) {
    state.targetProjects[existing] = project;
  } else {
    state.targetProjects.push(project);
  }
  saveWorkspaceState(state);
}

/** Remove a target project */
export function removeTargetProject(name: string): void {
  const state = loadWorkspaceState();
  state.targetProjects = state.targetProjects.filter((p) => p.name !== name);
  saveWorkspaceState(state);
}

/** List target projects */
export function listTargetProjects(): TargetProject[] {
  return loadWorkspaceState().targetProjects;
}
