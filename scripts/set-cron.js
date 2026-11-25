// Writes the schedule into vercel.json: one check-in every hour, which runs the update that
// pulls fresh numbers from the connected tools (GET /api?action=cron, Bearer CRON_SECRET).
//
//   node scripts/set-cron.js          write it
//   node scripts/set-cron.js --off    remove it

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'vercel.json');
const isOurs = (c) => /action=cron/.test(String(c.path));

function setCrons({ on = true } = {}, file = FILE) {
  const vercel = JSON.parse(fs.readFileSync(file, 'utf8'));
  const others = (vercel.crons || []).filter(c => !isOurs(c));
  const ours = on ? Array.from({ length: 24 }, (_, h) => ({ path: '/api?action=cron', schedule: `0 ${h} * * *` })) : [];
  const crons = [...others, ...ours];
  if (crons.length) vercel.crons = crons; else delete vercel.crons;
  fs.writeFileSync(file, JSON.stringify(vercel, null, 2) + '\n');
  return ours.length;
}

module.exports = { setCrons };

if (require.main === module) {
  const on = !process.argv.includes('--off');
  setCrons({ on });
  console.log(on
    ? 'Schedule written: checks in every hour. Set CRON_SECRET in Vercel: the update refuses to run without it.'
    : 'Schedule removed.');
}
