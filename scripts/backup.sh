#!/bin/bash
# Sauvegarde de la base Mongo (dump compressé) dans ./backups, en gardant les N derniers.
# Usage : scripts/backup.sh [dossier] [nb à garder]   — à mettre en cron, ex. tous les jours à 3h :
#   0 3 * * * cd /chemin/vers/RiftboundTournament && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
DIR="${1:-backups}"
KEEP="${2:-14}"
DB="${DB_NAME:-riftbound}"
CONTAINER="${MONGO_CONTAINER:-riftbound-mongo}"
mkdir -p "$DIR"
FILE="$DIR/$DB-$(date +%Y%m%d-%H%M%S).archive.gz"
docker exec "$CONTAINER" mongodump --quiet --db "$DB" --archive --gzip > "$FILE"
echo "$(date '+%F %T') sauvegarde → $FILE ($(du -h "$FILE" | cut -f1))"
ls -1t "$DIR"/"$DB"-*.archive.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
