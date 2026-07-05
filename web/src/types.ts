// Shared type contracts between the backend snapshot/serialize layer and the UI.

export type AgentState = {
  id: string;
  name: string;
  gender?: "female" | "male" | "unspecified" | string;
  persona: string;
  model: string;
  x: number;
  y: number;
  status: string;
  physiology: Record<string, number>;
  inventory: Record<string, number>;
  goals: string[];
  allies: number;
  rivals: number;
  diary: [number, string][];
  thought: string;
  action: string;
  said: string;
  decision_source?: string;   // llm | emergency | llm_fallback_stub | repair_stub | stub | wait
  relationships?: { id: string; name: string; label: string; score: number }[];
  best_ally?: string | null;
  following?: string | null;
  followers?: number;
  skills?: Record<string, number>;
  role?: string | null;
  beliefs?: { name: string; trust: number; note: string; tags: string[] }[];
};

export type FeedEntry = {
  tick: number;
  day: number;
  agent_id: string;
  agent: string;
  kind: "action" | "speech" | "social";
  thought: string;
  tool: string;
  result: string;
};

export type ChronicleEntry = {
  tick: number;
  day: number;
  kind: string;
  text: string;
  importance: number;
  agents: string[];
};

export type ResourceState = {
  id: string;
  kind: string;
  yield_item: string;
  x: number;
  y: number;
  quantity: number;
  max_quantity: number;
};

export type StructureState = {
  id: string;
  kind: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: Record<string, number | boolean | string>;
};

export type WorldState = {
  tick: number;
  day: number;
  is_night: boolean;
  weather: string | null;
  escaped: boolean;
  escape_winner: string | null;
  escape_progress: number;
  scenario: "mars" | "island";
  map: { size: number; grid: string[][] };
  agents: AgentState[];
  resources: ResourceState[];
  structures: StructureState[];
  feed: FeedEntry[];
  chronicle?: ChronicleEntry[];
  saga?: { tick: number; day: number; text: string }[];
  claims?: { node_id: string; owner_id: string; owner: string }[];
  metrics: {
    indicators: Record<string, number>;
    gini_inventory: number;
    tool_usage: Record<string, number>;
    barter_count: number;
    // Culture as data (Sprint 3): memes / story chains / currency experiment.
    culture?: {
      memes: {
        count: number; transmissions: number; famous: number;
        top: { text: string; author: string; kind: string; carriers: number }[];
      };
      stories: { chains: number; retellings: number; myths: number; max_drift: number };
      currency?: { item: string; transfers: number; holders: number; velocity: number };
    };
  };
  // Decision provenance: share of actions authored by each brain this run.
  provenance?: {
    total: number;
    heuristic_share: number;
    by_source: Record<string, number>;
  } | null;
};

// Backend-authoritative per-structure knowledge (footprint, build cost/progress).
// Fetched from /manifest so the frontend stops hardcoding these in several places.
export type Manifest = {
  scenario: string;
  map_size: number;
  structures: Record<string, {
    w: number; h: number;
    buildable?: boolean;
    required_progress?: number;
    cost?: Record<string, number>;
  }>;
};

export type ForgeConfig = {
  scenario: "mars" | "island";
  seed: number;
  provider?: string;
  sim: {
    max_days: number;
    api_tick_seconds?: number;
    emergency_multiplier?: number;
  };
  llm?: {
    fallback_policy?: string;
  };
  agents: {
    count: number;
    model_override?: string | null;
    persona_mode?: string;
    roster?: { name: string; model?: string }[];
  };
  budget: {
    usd_cap: number;
    tokens_per_agent_tick?: number;
    context_tokens_per_agent_tick?: number;
    max_output_tokens?: number;
  };
};

export type SimMeta = {
  sim_id: string;
  scenario?: string;
  day?: number;
  alive?: number;
  paused?: boolean;
  status?: string;
};
