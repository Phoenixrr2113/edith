/**
 * Proactive intervention tracker — cooldowns, rate limits, quiet hours.
 * Prevents notification fatigue while allowing Edith to act without being asked.
 */
import { join } from "path";
import { STATE_DIR } from "./config";
import { loadJson, saveJson } from "./storage";

const PROACTIVE_STATE_FILE = join(STATE_DIR, "proactive-state.json");
const PROACTIVE_CONFIG_FILE = join(STATE_DIR, "proactive-config.json");

interface Intervention {
  timestamp: string;
  category: string;
  message: string;
}

interface ProactiveState {
  interventions: Intervention[];
  lastCheck: string;
}

interface ProactiveConfig {
  maxPerHour: number;
  cooldownMinutes: number;
  quietHoursStart: number; // 24h format
  quietHoursEnd: number;
}

const DEFAULT_CONFIG: ProactiveConfig = {
  maxPerHour: 2,
  cooldownMinutes: 60,
  quietHoursStart: 22,
  quietHoursEnd: 8,
};

function loadState(): ProactiveState {
  return loadJson<ProactiveState>(PROACTIVE_STATE_FILE, { interventions: [], lastCheck: "" });
}

function saveState(state: ProactiveState): void {
  saveJson(PROACTIVE_STATE_FILE, state);
}

/**
 * Check if a proactive intervention is allowed right now.
 */
export function canIntervene(category?: string): { allowed: boolean; reason?: string } {
  // Check dashboard toggle
  const toggle = loadJson<{ enabled?: boolean }>(PROACTIVE_CONFIG_FILE, { enabled: true });
  if (toggle.enabled === false) {
    return { allowed: false, reason: "proactive disabled via dashboard" };
  }

  const config = DEFAULT_CONFIG;
  const now = new Date();
  const hour = now.getHours();

  // Quiet hours
  if (config.quietHoursStart > config.quietHoursEnd) {
    // Wraps midnight (e.g. 22–8)
    if (hour >= config.quietHoursStart || hour < config.quietHoursEnd) {
      return { allowed: false, reason: "quiet hours" };
    }
  } else {
    if (hour >= config.quietHoursStart && hour < config.quietHoursEnd) {
      return { allowed: false, reason: "quiet hours" };
    }
  }

  const state = loadState();
  const oneHourAgo = now.getTime() - 60 * 60 * 1000;

  // Rate limit: max interventions per hour
  const recentCount = state.interventions.filter(
    (i) => new Date(i.timestamp).getTime() > oneHourAgo
  ).length;
  if (recentCount >= config.maxPerHour) {
    return { allowed: false, reason: `rate limit (${recentCount}/${config.maxPerHour} this hour)` };
  }

  // Cooldown per category
  if (category) {
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const lastSameCategory = state.interventions
      .filter((i) => i.category === category)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];

    if (lastSameCategory && now.getTime() - new Date(lastSameCategory.timestamp).getTime() < cooldownMs) {
      return { allowed: false, reason: `cooldown (${category})` };
    }
  }

  return { allowed: true };
}

/**
 * Record that an intervention was made.
 */
export function recordIntervention(category: string, message: string): void {
  const state = loadState();

  state.interventions.push({
    timestamp: new Date().toISOString(),
    category,
    message: message.slice(0, 200),
  });

  // Keep only last 24h of history
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  state.interventions = state.interventions.filter(
    (i) => new Date(i.timestamp).getTime() > cutoff
  );

  state.lastCheck = new Date().toISOString();
  saveState(state);
}

/**
 * Get recent intervention history (for Claude to check what it already suggested).
 */
export function getInterventionHistory(hours: number = 4): Intervention[] {
  const state = loadState();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return state.interventions
    .filter((i) => new Date(i.timestamp).getTime() > cutoff)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
