// Decides whether a rendered page is a real page, a bot wall (CAPTCHA/challenge) or an error.
// Outages and CAPTCHAs are NEVER treated as content changes.

const CHALLENGE_RE =
  /(captcha|recaptcha|hcaptcha|turnstile|verify (that )?you('| a)?re (a )?human|are you a robot|unusual traffic|checking your browser|just a moment|attention required|access denied|request blocked|bot detection|pardon our interruption|enable javascript and cookies to continue)/i;

export function classifyPage({ status = 200, title = '', text = '', hasChallengeWidget = false }) {
  const body = text.trim();
  const len = body.length;

  const titleHit = CHALLENGE_RE.test(title) && len < 2500;
  const bodyHit = CHALLENGE_RE.test(body.slice(0, 1500)) && len < 2500;
  const widgetOnly = hasChallengeWidget && len < 500;
  const walledStatus = [403, 429, 503].includes(status) && CHALLENGE_RE.test(`${title}\n${body.slice(0, 3000)}`);

  if (titleHit || bodyHit || widgetOnly || walledStatus) {
    return { state: 'blocked', detail: `Bot challenge / CAPTCHA detected (HTTP ${status})` };
  }
  if (status === 429) return { state: 'blocked', detail: 'Rate limited by the site (HTTP 429)' };
  if (status === 401 || status === 403) return { state: 'blocked', detail: `Access denied (HTTP ${status})` };
  if (status >= 500) return { state: 'error', detail: `Server error (HTTP ${status})` };
  if (status >= 400) return { state: 'error', detail: `HTTP ${status}` };
  if (status === 0) return { state: 'error', detail: 'No response from server' };
  if (len < 20) return { state: 'error', detail: 'Page rendered empty' };
  return { state: 'ok', detail: null };
}
