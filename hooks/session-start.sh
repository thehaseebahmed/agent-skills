#!/bin/sh
# session-start.sh — print the installed skill inventory at session start.
#
# A SessionStart hook runs before the agent does anything useful, so it must
# never block: every failure path here still exits 0.

set -u

# Resolve the pack root from wherever this script was invoked.
hook_dir=$(dirname "$0")
pack_root=$(cd "$hook_dir/.." 2>/dev/null && pwd) || exit 0
skills_dir="$pack_root/skills"

[ -d "$skills_dir" ] || exit 0

count=0
names=""
for dir in "$skills_dir"/*/; do
  [ -f "$dir/SKILL.md" ] || continue
  count=$((count + 1))
  names="$names  - $(basename "$dir")
"
done

if [ "$count" -eq 0 ]; then
  echo "agent-skills: no skills installed yet (skills/ is empty)."
  exit 0
fi

echo "agent-skills: $count skill(s) available."
printf '%s' "$names"
echo "Consult the matching skill before starting work it covers."
exit 0
