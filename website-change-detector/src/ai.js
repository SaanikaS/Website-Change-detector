import { config } from './config.js';
import { log } from './util.js';

/** Optional bonus: one-line change summary from Claude. Returns null if not configured or on any error. */
export async function aiSummary(monitor, d) {
  if (!config.anthropicKey) return null;
  try {
    const removed = d.removedLines.join('\n').slice(0, 1500);
    const added = d.addedLines.join('\n').slice(0, 1500);
    const prompt =
      `A monitored web page ("${monitor.name}") changed. Summarize the change in ONE plain sentence (max 25 words). ` +
      `Do not mention diffs or line counts.\n\nREMOVED:\n${removed || '(nothing)'}\n\nADDED:\n${added || '(nothing)'}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.content?.[0]?.text?.trim() || null;
  } catch (e) {
    log('AI summary failed:', e.message);
    return null;
  }
}
