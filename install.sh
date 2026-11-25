#!/usr/bin/env bash
# Installs the Claude Code skill that sets up this template: copies skill/ to
# ~/.claude/skills/webinar-dashboard
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.claude/skills/webinar-dashboard"
mkdir -p "${DEST}"
cp -R "${HERE}/skill/." "${DEST}/"
echo "Installed the webinar-dashboard skill to ${DEST}"
echo "In Claude Code, say \"set up the webinar dashboard\" or type /webinar-dashboard"
