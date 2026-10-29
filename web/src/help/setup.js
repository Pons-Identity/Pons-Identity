// Help articles for the setup wizard, migration from other identity providers, data export and upgrades.
// Blocks: a string is a paragraph; { steps } numbered; { bullets } a list; { tip } a note; { warning } a caution; { heading } a subheading;
// { table: { head, rows } } a table. **bold** marks control names; `code` marks code.

import { admin, holds } from './visibility.js';

const setupWizard = holds('setup.run');
const migrate = holds('migration.manage');
const exporter = holds('export.manage');

export const SETUP_ARTICLES = [
  {
    slug: 'rerun-setup-wizard',
    section: 'Setup and migration',
    title: 'Re-run the setup wizard',
    summary: 'Change the product name, colors, session limits or import users again.',
    visible: setupWizard,
    body: [
      { steps: [
        'Open **Settings** from the module menu and select the **Setup wizard** tab.',
        'Select **Open the setup wizard**.',
        'Change the **Product name**, **Primary color**, or the session settings, or import from another identity provider on the **Import** step.',
        'Select **Finish setup**. Your changes are saved, and the administrator account is not touched.',
      ] },
      'You do not need the setup token to re-run the wizard. It only asks for one when nobody can sign in yet.',
      { tip: 'The wizard switches itself off after its first run. Only people with the **Re-run the setup wizard** permission can open it again.' },
    ],
  },
  {
    slug: 'migrate-from-another-provider',
    section: 'Setup and migration',
    title: 'Migrate from Shibboleth, Okta or Microsoft',
    summary: 'Bring users, groups and applications over from another identity provider.',
    visible: migrate,
    body: [
      { steps: [
        'Export the files from your current provider. Shibboleth: the metadata, `attribute-resolver.xml`, `attribute-filter.xml` and `relying-party.xml`. Okta: the users CSV and the groups and apps JSON. Microsoft: the Entra ID users CSV or Graph JSON, and the AD FS or Active Directory exports.',
        'Open **Settings**, then select the **Migration** tab.',
        'Under **Coming from**, choose your provider. The files it needs appear, each in its own slot.',
        'Under **Usernames**, choose whether to keep the whole login, such as `ada@example.net`, or only the part before the `@`.',
        'Under each file, select **Choose file** (or **Add files** where a slot takes several) and pick the file you exported. Skip any you do not have. Each guide says where to find them.',
        'Select **Preview what will be imported**.',
        'Read the **Found** list and the notes. Open each section to check its rows, and untick anything you do not want.',
        'Select **Import**.',
      ] },
      { heading: 'What happens to what you import' },
      { bullets: [
        '**Existing items are skipped.** A user, group or application with the same name or entity ID is left alone. Nothing is overwritten.',
        '**Imported users get a password nobody knows.** They can use password recovery to set their own, or you can set one for them.',
        '**Applications start turned off.** Tick **Let everyone sign in to imported applications straight away** only after you have checked them.',
        '**New client secrets appear once.** Copy any secret shown on the result page before you leave it.',
      ] },
      { tip: 'Shibboleth does not keep a list of people, because it checks sign-ins against a directory. Add that directory under **External systems → Directories** so people can keep signing in.' },
      'Step by step for each provider: [Migrate from Shibboleth](/help/migrate-from-shibboleth), [Migrate from Okta](/help/migrate-from-okta) and [Migrate from Microsoft](/help/migrate-from-microsoft).',
      'Your files stay in memory for an hour and are never saved to disk. Preview first: nothing is created until you select **Import**.',
    ],
  },
  {
    slug: 'export-data',
    section: 'Data export',
    title: 'Export configuration, users and groups',
    summary: 'Download a copy of your setup as a JSON file or a zip.',
    visible: exporter,
    body: [
      { steps: [
        'Open **Settings**, then select the **Export** tab.',
        'Tick each part you want: **Configuration**, **Users**, **Groups and group structure** or **Integrations**.',
        'Under **Format**, choose **JSON file**, or **Zip of separate files (with users.csv)** to get one file per part plus a spreadsheet of users.',
        'Select **Download export**.',
      ] },
      'A part you cannot see is greyed out. To export users, you also need **View users**; for groups, **View groups**; for integrations, **View integrations**.',
      { warning: 'An export never includes password hashes, authenticator secrets, private keys, client secrets, tokens or the values of secret variables. Still, treat the file as sensitive: it shows how your sign-in is set up.' },
      'An export is a record of what is set up, not a backup. It cannot restore passwords or second factors. Every download is recorded in the audit log.',
    ],
  },
  {
    slug: 'upgrade-pons-identity',
    section: 'Upgrades',
    title: 'Upgrade Pons Identity in place',
    summary: 'Install a newer release on the same server, with a backup and a way back.',
    visible: admin,
    body: [
      { steps: [
        'Download the new release, either as a folder or as a `.zip` or `.tar.gz`, and leave it in your Downloads folder.',
        'Stop Pons Identity.',
        'In a terminal in the Pons Identity folder, run `npm run upgrade -- --dry-run ~/Downloads` to see what will happen. Nothing changes yet.',
        'Run `npm run upgrade -- ~/Downloads` and type `y` when asked.',
        'Start Pons Identity again and sign in to check it.',
      ] },
      'The upgrade takes a backup first and keeps your data, configuration and dependencies in place. If the new version fails to start, it puts the old one back for you.',
      { heading: 'Undo an upgrade' },
      { steps: [
        'Stop Pons Identity.',
        'Run `npm run upgrade -- list` to see the backups.',
        'Run `npm run upgrade -- rollback latest`, or name a backup from the list.',
        'Start Pons Identity again.',
      ] },
      { warning: 'A rollback also puts the database back to how it was before that upgrade, so changes made since then are lost. Pass `--keep-data` to restore only the code. A copy of the current database is kept in the backup.' },
      { tip: 'The upgrade tool runs on the server, not in the console. Stop Pons Identity first, or the tool refuses to continue. In Docker, replace the image instead.' },
    ],
  },
];
