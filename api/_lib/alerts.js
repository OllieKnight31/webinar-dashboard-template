// One optional place to be told when something needs attention (a sync failed, a sign-up
// could not reach the CRM): a Slack or Discord incoming webhook address saved on Settings.
// No address saved = nothing is sent. Never throws.

const { config } = require('./config');

async function alert(title, lines = []) {
  const url = config.alerts_webhook;
  if (!url) return { status: 'skipped' };
  const text = [`*${title}*`, ...lines].join('\n').slice(0, 1800);
  try {
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Slack reads `text`, Discord reads `content`; each ignores the other
      body: JSON.stringify(/discord/.test(url) ? { content: text.replace(/\*(.+?)\*/g, '**$1**') } : { text }),
      signal: AbortSignal.timeout(8000),
    });
    return { status: resp.ok ? 'ok' : 'error' };
  } catch (e) {
    console.error('[alerts] could not send:', e.message);
    return { status: 'error' };
  }
}

module.exports = { alert };
