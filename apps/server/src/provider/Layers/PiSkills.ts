// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const PiSkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.String,
});
const decodePiSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(PiSkillFrontmatter));
const FRONTMATTER_PATTERN = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/;

export function resolvePiSkillsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredAgentDirectory = environment.PI_CODING_AGENT_DIR?.trim();
  const agentDirectory = configuredAgentDirectory
    ? configuredAgentDirectory === "~"
      ? NodeOS.homedir()
      : configuredAgentDirectory.startsWith("~/") || configuredAgentDirectory.startsWith("~\\")
        ? NodePath.join(NodeOS.homedir(), configuredAgentDirectory.slice(2))
        : configuredAgentDirectory
    : NodePath.join(NodeOS.homedir(), ".pi", "agent");
  return NodePath.resolve(agentDirectory, "skills");
}

function readPiSkill(
  skillPath: string,
): Effect.Effect<ServerProviderSkill | undefined, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(skillPath);
    const frontmatterSource = FRONTMATTER_PATTERN.exec(source)?.[1];
    if (!frontmatterSource) return undefined;

    const frontmatter = yield* decodePiSkillFrontmatter(frontmatterSource);
    const name = frontmatter.name?.trim() || NodePath.basename(NodePath.dirname(skillPath)).trim();
    const description = frontmatter.description.trim();
    if (!name || !description) return undefined;

    return {
      name,
      description,
      path: skillPath,
      scope: "user",
      enabled: true,
    } satisfies ServerProviderSkill;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

export const discoverPiSkills = Effect.fn("discoverPiSkills")(function* (
  skillsDirectory: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(skillsDirectory, { recursive: true })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  const skillPaths = entries
    .filter((entry) => NodePath.basename(entry) === "SKILL.md")
    .map((entry) => NodePath.join(skillsDirectory, entry))
    .sort((left, right) => left.localeCompare(right));
  const discovered = yield* Effect.forEach(skillPaths, readPiSkill, {
    concurrency: "unbounded",
  });
  const seenNames = new Set<string>();

  return discovered.flatMap((skill) => {
    if (!skill || seenNames.has(skill.name)) return [];
    seenNames.add(skill.name);
    return [skill];
  });
});
