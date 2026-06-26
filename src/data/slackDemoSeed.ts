import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SlackHistoryResponse {
  ok: boolean;
  messages?: Array<{ text?: string }>;
  error?: string;
}

interface SlackPostResponse {
  ok: boolean;
  error?: string;
}

const marker = "[slack-detective-demo:checkout-latency]";

const messages = [
  `${marker} 16:04 UTC - checkout-service v2.14.0 just deployed with the regional tax calculation changes.`,
  `${marker} 16:12 UTC - checkout p95 is at 2.8s, up from 420ms. Slow traces all show repeated tax_rule reads per cart item.`,
  `${marker} 16:35 UTC - support is seeing payment spinner timeouts for wholesale carts with 20+ line items.`,
  `${marker} 17:06 UTC - rolled back v2.14.0. Checkout p95 recovered within six minutes.`,
  `${marker} follow-up - remediation is to batch tax rules before the cart loop and add a query-count regression gate.`
];

export async function seedSlackDemo(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = requireEnv(env, "SLACK_BOT_TOKEN");
  const channel = requireEnv(env, "DEMO_SLACK_CHANNEL_ID");

  const existing = await slackRequest<SlackHistoryResponse>(token, "conversations.history", {
    channel,
    limit: "100"
  });
  if (existing.messages?.some((message) => message.text?.includes(marker))) {
    console.log(`Slack demo messages already exist in ${channel}.`);
    return;
  }

  for (const text of messages) {
    await slackRequest<SlackPostResponse>(token, "chat.postMessage", {
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false
    });
  }

  console.log(`Seeded ${messages.length} Slack demo messages in ${channel}.`);
}

async function slackRequest<T extends { ok: boolean; error?: string }>(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json() as T;
  if (!response.ok || !payload.ok) {
    throw new Error(`Slack ${method} failed: ${response.status} ${payload.error ?? response.statusText}`);
  }
  return payload;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seedSlackDemo().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
