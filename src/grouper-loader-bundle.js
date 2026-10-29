const { SUBJECT_COLUMNS } = require('./grouper-feed');
const appSettings = require('./app-settings');

// Files that let a Grouper administrator load the feed into a staging table that Grouper's SQL loader reads.
// Nothing here is run by Pons Identity, and the real token is never written into a file.

function staging(cfg) {
  const subjectCol = cfg.subjectColumn;
  const withSource = Boolean(cfg.subjectSourceId);
  return `-- Staging tables for the ${appSettings.productName()} feed. PostgreSQL syntax; adjust types for MySQL or Oracle.
-- Create them in the database Grouper's loader is configured to read (often the Grouper database itself).

CREATE TABLE IF NOT EXISTS simpleidp_groups (
  group_name VARCHAR(1024) PRIMARY KEY,
  group_display_name VARCHAR(1024),
  group_description VARCHAR(4000)
);

CREATE TABLE IF NOT EXISTS simpleidp_memberships (
  group_name VARCHAR(1024) NOT NULL,
  ${subjectCol} VARCHAR(255) NOT NULL${withSource ? ',\n  subject_source_id VARCHAR(255) NOT NULL' : ''},
  PRIMARY KEY (group_name, ${subjectCol})
);
`;
}

function syncScript(cfg, feedBase) {
  const cols = [cfg.subjectColumn, ...(cfg.subjectSourceId ? ['subject_source_id'] : [])];
  return `#!/bin/sh
# Copies the ${appSettings.productName()} feed into the staging tables Grouper's loader reads. Run it before each loader run (cron).
#
#   SIMPLEIDP_FEED_TOKEN   the feed token from ${appSettings.productName()} (required)
#   DATABASE_URL           psql connection string for the staging database (required)
#   SIMPLEIDP_FEED_URL     defaults to ${feedBase}
#   ALLOW_EMPTY=1          accept a feed with no memberships (otherwise the load is refused)
#   MAX_SHRINK_PCT=50      refuse a feed that drops more than this percent of the current rows

set -eu
: "\${SIMPLEIDP_FEED_TOKEN:?set SIMPLEIDP_FEED_TOKEN}"
: "\${DATABASE_URL:?set DATABASE_URL}"
URL="\${SIMPLEIDP_FEED_URL:-${feedBase}}"
MAX_SHRINK_PCT="\${MAX_SHRINK_PCT:-50}"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
chmod 700 "$dir"

fetch() { curl --fail --silent --show-error --max-time 120 -H "Authorization: Bearer $SIMPLEIDP_FEED_TOKEN" "$URL/$1" -o "$dir/$1"; }
fetch groups.csv
fetch memberships.csv

rows=$(($(wc -l < "$dir/memberships.csv") - 1))
if [ "$rows" -le 0 ] && [ "\${ALLOW_EMPTY:-0}" != "1" ]; then
  echo "The feed has no memberships; refusing to empty the staging tables (set ALLOW_EMPTY=1 to allow)." >&2
  exit 1
fi
current=$(psql "$DATABASE_URL" -tA -c 'SELECT COUNT(*) FROM simpleidp_memberships')
if [ "$current" -gt 0 ] && [ $((rows * 100)) -lt $((current * (100 - MAX_SHRINK_PCT))) ]; then
  echo "The feed has $rows memberships, down from $current; refusing to load it (raise MAX_SHRINK_PCT to allow)." >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM simpleidp_groups;
DELETE FROM simpleidp_memberships;
\\copy simpleidp_groups (group_name, group_display_name, group_description) FROM '$dir/groups.csv' WITH (FORMAT csv, HEADER true)
\\copy simpleidp_memberships (group_name, ${cols.join(', ')}) FROM '$dir/memberships.csv' WITH (FORMAT csv, HEADER true)
COMMIT;
SQL
echo "Loaded $rows memberships."
`;
}

function loaderSettings(cfg, stems) {
  const lines = [
    `Grouper loader settings for the ${appSettings.productName()} feed`,
    '',
    'One loader job per top-level folder, so each job only manages groups under its own folder.',
    'In the Grouper UI open the group that will hold the job, then Group actions -> Loader -> Edit loader configuration.',
    'Field labels and attribute names differ between Grouper versions; the values below are what to enter.',
    '',
    'Common to every job',
    '  Loader type:        SQL_GROUP_LIST',
    '  Database:           the database holding the staging tables (the Grouper database is named "grouper" by default)',
    '  Schedule:           CRON, a little after the staging load (for example 15 minutes past each hour)',
    `  Query columns:      group_name, ${cfg.subjectColumn}${cfg.subjectSourceId ? ', subject_source_id' : ''}  (no ORDER BY; keep "where" separated by spaces)`,
    '',
  ];
  for (const stem of stems) {
    lines.push(
      `Folder "${stem}"`,
      `  Query:              select group_name, ${cfg.subjectColumn}${cfg.subjectSourceId ? ', subject_source_id' : ''} from simpleidp_memberships where group_name like '${stem}:%'`,
      `  Group query:        select group_name, group_display_name, group_description from simpleidp_groups where group_name like '${stem}:%'`,
      `  Groups like:        ${stem}:%`,
      '',
    );
  }
  lines.push(
    'What to expect',
    '  - Loader-managed groups take their members only from the feed; edits made to them in Grouper are undone on the next run.',
    '  - The feed flattens nested groups and composites, so the loader will not keep memberships that only the web-services push added',
    '    (for example a nested group added as a member). Grouper then shows the same people, directly.',
    `  - Groups removed from ${appSettings.productName()} are removed from the feed, and the loader will delete the matching groups under "Groups like".`,
    '  - "_" in a folder name is a single-character wildcard in LIKE patterns; it can over-match a sibling folder.',
    `  - To leave the loader and make Grouper the source of truth, use Cut over in ${appSettings.productName()}, then delete these loader jobs.`,
  );
  return `${lines.join('\n')}\n`;
}

function readme(cfg, feedBase, counts) {
  return `${appSettings.productName()} -> Grouper loader feed
${new Date().toISOString()}

Feed:        ${feedBase}/memberships.csv and groups.csv (also .json)
People by:   ${cfg.subjectField}   -> column "${cfg.subjectColumn}"${cfg.subjectSourceId ? `, source "${cfg.subjectSourceId}"` : ''}
Contents:    ${counts.groups} groups, ${counts.memberships} memberships
Names:       groups without ":" are under the folder "${cfg.rootStem}"

How it fits together
  1. staging.sql    create the staging tables once.
  2. sync.sh        run before each loader run; it downloads the feed and replaces the staging rows in one transaction.
                    It refuses an empty feed, or one that shrinks sharply, so a bad day in ${appSettings.productName()} does not empty Grouper.
  3. loader-settings.txt   the loader jobs to define in Grouper.

The token is not in these files: pass it as SIMPLEIDP_FEED_TOKEN. Anyone holding it can read every group and
member identifier, so keep it in a secret store and replace it from ${appSettings.productName()} if it leaks.

Not run against a real Grouper by ${appSettings.productName()}. Try it on a test Grouper first.
`;
}

module.exports = { staging, syncScript, loaderSettings, readme, SUBJECT_COLUMNS };
