import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import type { SubagentProviderConfig } from "./local-agent-config.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  effort?: string;
  writeMode?: "read_only";
}

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  model?: string;
  effort?: string;
  writeMode?: "read_only";
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProvider;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
    };

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents run <profile-or-provider> [--read-only] [--model <model>] [--effort <level>] "<prompt>"',
  );
  return parsed;
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents continue <id> [--read-only] [--model <model>] [--effort <level>] "<prompt>"',
  );
  return { agentId: parsed.target, prompt: parsed.prompt, model: parsed.model, effort: parsed.effort, ...(parsed.writeMode ? { writeMode: parsed.writeMode } : {}) };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;
  if (!target) {
    throw new Error(usage);
  }

  let model: string | undefined;
  let effort: string | undefined;
  let writeMode: "read_only" | undefined;
  const promptParts: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!optionsEnded && part === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      promptParts.push(part ?? "");
      continue;
    }
    if (part === "--read-only") {
      writeMode = "read_only";
      continue;
    }
    if (part === "--model") {
      const value = parseOptionValue(rest[index + 1], "--model");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = parseOptionValue(part.slice("--model=".length), "--model");
      model = value;
      continue;
    }
    if (part === "--effort") {
      const value = parseOptionValue(rest[index + 1], "--effort");
      effort = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--effort=")) {
      const value = parseOptionValue(part.slice("--effort=".length), "--effort");
      effort = value;
      continue;
    }
    if (part?.startsWith("-")) {
      throw unknownOptionError(part);
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error(usage);
  }

  return { target, prompt, model, effort, ...(writeMode ? { writeMode } : {}) };
}

function parseOptionValue(value: string | undefined, option: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing value for ${option}.`);
  if (trimmed.startsWith("-")) throw unknownOptionError(trimmed);
  return trimmed;
}

function unknownOptionError(option: string): Error {
  return new Error(`Unknown option: ${option}. Use -- before prompt text that starts with a dash.`);
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
  providerConfigs: readonly SubagentProviderConfig[] = [],
): LocalAgentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);
  if (profile) {
    const providerConfig = providerConfigs.find((entry) => entry.id === profile.provider);
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model ?? providerConfig?.model,
      effort: effortOverride ?? profile.effort ?? providerConfig?.effort,
      profile,
    };
  }

  if (isLocalAgentProvider(target)) {
    const providerConfig = providerConfigs.find((entry) => entry.id === target);
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride ?? providerConfig?.model,
      effort: effortOverride ?? providerConfig?.effort,
    };
  }

  return undefined;
}
