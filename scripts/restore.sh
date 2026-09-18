#!/bin/bash
# Restauration d'une sauvegarde produite par backup.sh (remplace la base existante).
# Usage : scripts/restore.sh backups/riftbound-20260918-030000.archive.gz
set -euo pipefail
FILE="${1:?fichier .archive.gz requis}"
DB="${DB_NAME:-riftbound}"
CONTAINER="${MONGO_CONTAINER:-riftbound-mongo}"
read -r -p "Remplacer la base « $DB » du conteneur $CONTAINER par $FILE ? [o/N] " ok
[[ "$ok" == "o" || "$ok" == "O" ]] || exit 1
docker exec -i "$CONTAINER" mongorestore --quiet --archive --gzip --drop --nsInclude="$DB.*" < "$FILE"
echo "Restauration terminée."
