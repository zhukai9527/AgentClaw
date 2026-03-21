/** Skill definition — loaded from SKILL.md files */
export interface Skill {
  id: string;
  name: string;
  description: string;
  /** File path to the SKILL.md */
  path: string;
  /** Instructions injected into system prompt when active */
  instructions: string;
  /** Whether this skill is enabled */
  enabled: boolean;
  /** Usage statistics */
  lastUsedAt?: Date;
  useCount: number;
}

/** Skill match result */
export interface SkillMatch {
  skill: Skill;
  /** Confidence score (0-1) */
  confidence: number;
}

/** Skill registry — manages available skills */
export interface SkillRegistry {
  /** Load skills from a directory */
  loadFromDirectory(dirPath: string): Promise<void>;

  /** Register a skill */
  register(skill: Skill): void;

  /** Find matching skills for a given input */
  match(input: string): Promise<SkillMatch[]>;

  /** Get a skill by ID */
  get(id: string): Skill | undefined;

  /** List all skills */
  list(): Skill[];

  /** Enable/disable a skill */
  setEnabled(id: string, enabled: boolean): void;
}
