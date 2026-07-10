import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgentToolProvider } from "../agent/toolProvider.js";
import type { ServiceToken } from "../auth/tokenStore.js";
import type { EvidenceItem } from "../types/schemas.js";

/**
 * Strava's tools for the investigation agent. Product-specific code is expected and contained
 * HERE — this file is a plugin referenced only by the strava row in src/services/registry.ts.
 * The agent core never knows Strava exists; it just sees tools whose results may carry an
 * `evidence` array (the generic contract harvested in investigator.ts).
 */

const API_BASE = "https://www.strava.com/api/v3";
const METERS_PER_MILE = 1609.344;

interface StravaActivity {
  id?: number;
  name?: string;
  sport_type?: string;
  type?: string;
  distance?: number;
  moving_time?: number;
  total_elevation_gain?: number;
  start_date?: string;
  average_speed?: number;
}

function miles(meters: number | undefined): number {
  return meters ? Math.round((meters / METERS_PER_MILE) * 100) / 100 : 0;
}

function minutes(seconds: number | undefined): number {
  return seconds ? Math.round(seconds / 60) : 0;
}

function summarizeActivity(activity: StravaActivity): Record<string, unknown> {
  return {
    id: activity.id,
    name: activity.name,
    sport: activity.sport_type ?? activity.type,
    miles: miles(activity.distance),
    movingMinutes: minutes(activity.moving_time),
    elevationGainMeters: activity.total_elevation_gain,
    startDate: activity.start_date
  };
}

function activityEvidence(activity: StravaActivity): EvidenceItem | null {
  if (!activity.id || !activity.start_date) return null;
  const sport = activity.sport_type ?? activity.type ?? "activity";
  return {
    id: `strava:activity:${activity.id}`,
    source: "strava",
    title: `Strava ${sport}: ${activity.name ?? `activity ${activity.id}`}`,
    body: `${miles(activity.distance)} mi ${sport.toLowerCase()} in ${minutes(activity.moving_time)} min on ${activity.start_date.slice(0, 10)}.`,
    url: `https://www.strava.com/activities/${activity.id}`,
    timestamp: activity.start_date,
    entities: [sport],
    tags: ["strava", "activity"],
    confidence: 0.9
  };
}

export class StravaToolProvider implements AgentToolProvider {
  constructor(private readonly token: ServiceToken) {}

  async listAgentTools(): Promise<ChatCompletionTool[]> {
    return [
      {
        type: "function",
        function: {
          name: "strava_list_activities",
          description:
            "List the connected user's own Strava activities (runs, rides, swims, ...), newest first, with distance in miles and moving time. Use this for any question about their workouts, mileage, pace, or training over a time period.",
          parameters: {
            type: "object",
            properties: {
              days: { type: "number", description: "How many days back to look. Default 30." },
              per_page: { type: "number", description: "Max activities to return (up to 100). Default 30." }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "strava_activity_detail",
          description: "Get one Strava activity's full details by id (from strava_list_activities).",
          parameters: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "strava_athlete_stats",
          description:
            "Get the connected user's all-time, year-to-date, and recent (last 4 weeks) Strava totals for rides, runs, and swims.",
          parameters: { type: "object", properties: {} }
        }
      }
    ];
  }

  has(name: string): boolean {
    return ["strava_list_activities", "strava_activity_detail", "strava_athlete_stats"].includes(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      switch (name) {
        case "strava_list_activities":
          return await this.listActivities(args);
        case "strava_activity_detail":
          return await this.activityDetail(args);
        case "strava_athlete_stats":
          return await this.athleteStats();
        default:
          return { error: `Unknown Strava tool: ${name}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async fetchJson(path: string): Promise<unknown> {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.token.token}` }
    });
    if (response.status === 401) {
      throw new Error("Strava rejected the stored token (expired or revoked). The user should reconnect Strava.");
    }
    if (!response.ok) throw new Error(`Strava API returned HTTP ${response.status} for ${path}.`);
    return response.json();
  }

  private async listActivities(args: Record<string, unknown>): Promise<unknown> {
    const days = typeof args.days === "number" && args.days > 0 ? Math.min(args.days, 365) : 30;
    const perPage = typeof args.per_page === "number" && args.per_page > 0 ? Math.min(args.per_page, 100) : 30;
    const after = Math.floor((Date.now() - days * 86_400_000) / 1000);
    const activities = (await this.fetchJson(`/athlete/activities?after=${after}&per_page=${perPage}`)) as StravaActivity[];

    const evidence = activities.map(activityEvidence).filter((item): item is EvidenceItem => item !== null);
    const totalMiles = Math.round(activities.reduce((sum, activity) => sum + miles(activity.distance), 0) * 100) / 100;
    return {
      data: {
        lookbackDays: days,
        count: activities.length,
        totalMiles,
        activities: activities.map(summarizeActivity)
      },
      evidence
    };
  }

  private async activityDetail(args: Record<string, unknown>): Promise<unknown> {
    const id = typeof args.id === "number" ? args.id : Number(args.id);
    if (!Number.isFinite(id)) return { error: "An activity id is required." };
    const activity = (await this.fetchJson(`/activities/${id}`)) as StravaActivity & { description?: string };
    const evidenceItem = activityEvidence(activity);
    return {
      data: { ...summarizeActivity(activity), description: activity.description },
      evidence: evidenceItem ? [evidenceItem] : []
    };
  }

  private async athleteStats(): Promise<unknown> {
    if (!this.token.accountId) return { error: "The connected Strava account id is missing; reconnect Strava." };
    const stats = (await this.fetchJson(`/athletes/${this.token.accountId}/stats`)) as Record<
      string,
      { count?: number; distance?: number; moving_time?: number } | unknown
    >;
    const totals = (key: string) => {
      const total = stats[key] as { count?: number; distance?: number; moving_time?: number } | undefined;
      return total ? { count: total.count, miles: miles(total.distance), movingMinutes: minutes(total.moving_time) } : undefined;
    };
    return {
      data: {
        recentRuns: totals("recent_run_totals"),
        recentRides: totals("recent_ride_totals"),
        recentSwims: totals("recent_swim_totals"),
        yearToDateRuns: totals("ytd_run_totals"),
        yearToDateRides: totals("ytd_ride_totals"),
        allTimeRuns: totals("all_run_totals"),
        allTimeRides: totals("all_ride_totals")
      },
      evidence: [
        {
          id: `strava:stats:${this.token.accountId}`,
          source: "strava",
          title: `Strava training stats for ${this.token.accountLabel ?? "the connected athlete"}`,
          body: "Recent (4-week), year-to-date, and all-time run/ride/swim totals from the Strava stats API.",
          url: `https://www.strava.com/athletes/${this.token.accountId}`,
          timestamp: new Date().toISOString(),
          entities: ["strava"],
          tags: ["strava", "stats"],
          confidence: 0.9
        } satisfies EvidenceItem
      ]
    };
  }
}
