#!/usr/bin/env bash
# Commitne subor so stavom spat do repa.
#
# Preco to nie je proste `git push`: vsetky tri workflowy (pocasie, kalendar,
# emaily) pisu do toho isteho repa a ked sa dva behy prekryju, druhemu push
# zlyha na non-fast-forward. Job potom spadne UZ PO tom, co sa sprava odoslala,
# takze sa stratil len zapis stavu - a pri dalsom behu prisla ta ista sprava
# znova. Presne to sa stalo 13. 9. 2026 s rannou agendou.
#
# Riesenie: pri kolizii sa stav prerebasuje na aktualny main a push sa zopakuje.
set -euo pipefail

FILE="$1"
MESSAGE="$2"
BRANCH="${GITHUB_REF_NAME:-main}"
ATTEMPTS=5

git config user.name "melichar-bot"
git config user.email "actions@users.noreply.github.com"

git add "$FILE"
if git diff --cached --quiet; then
  echo "Stav sa nezmenil, nie je co commitnut."
  exit 0
fi

git commit -m "$MESSAGE"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git push origin "HEAD:$BRANCH"; then
    echo "Stav zapisany (pokus $attempt)."
    exit 0
  fi
  echo "Push zlyhal (pokus $attempt) - medzitym pribudol iny commit, rebasujem."
  git fetch origin "$BRANCH"
  # --autostash pre istotu: beh mohol zanechat aj iny rozpracovany subor.
  git pull --rebase --autostash origin "$BRANCH"
done

echo "Push sa nepodaril ani na $ATTEMPTS. pokus." >&2
exit 1
