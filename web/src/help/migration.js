// Help articles for moving to Pons Identity from Shibboleth, Okta and Microsoft. Same blocks as the other help files:
// a string is a paragraph; { steps } numbered; { bullets } a list; { tip } a note; { warning } a caution; { heading } a subheading.
// **bold** marks control names; `code` marks code. Each guide lists the files the import asks for, in the order the Migration tab shows them.

import { holds } from './visibility.js';

const migrate = holds('migration.manage');

export const MIGRATION_ARTICLES = [
  {
    slug: 'migrate-from-shibboleth',
    section: 'Setup and migration',
    title: 'Migrate from Shibboleth',
    summary: 'Move your service providers and what each one receives from a Shibboleth IdP.',
    visible: migrate,
    body: [
      'Shibboleth does not keep a list of people. It checks sign-ins against a directory, and it keeps its service providers and their attribute rules in files. Pons Identity reads those files and creates an application for each service provider, with the attributes it was released.',
      { heading: 'Find the files' },
      'Most of them are in the IdP\'s `conf` folder. On many installs that is `/opt/shibboleth-idp/conf`. If you are not sure where yours is, run `find / -name idp.properties 2>/dev/null` on the IdP server. The folder that holds that file is your `conf` folder.',
      { bullets: [
        '**Service provider metadata** (needed). Open `conf/metadata-providers.xml`. It names each metadata file and web address the IdP trusts. Upload those files. For a web address, open it in your browser and save the page as an `.xml` file.',
        '**Attribute resolver**: `conf/attribute-resolver.xml`. It names each attribute and the SAML name it is sent under. Without it, the import has to guess those names.',
        '**Attribute filter**: `conf/attribute-filter.xml`. It says which attributes each service provider receives.',
        '**Relying party settings**: `conf/relying-party.xml`, on IdP 3 and later. Upload it only if you changed signing or encryption for particular services.',
        '**IdP and LDAP properties**: `conf/idp.properties`, and `conf/ldap.properties` if it is there. They give the entity ID and the directory people sign in against. The import uses them for notes; it copies nothing from them.',
      ] },
      { tip: 'Some metadata files list every service in a federation. Importing one creates an application for each service it lists. Upload only the metadata for services you run.' },
      { heading: 'Import' },
      { steps: [
        'Open **Settings**, select the **Migration** tab, and set **Coming from** to **Shibboleth IdP**.',
        'Under **Service provider metadata**, select **Add files** and pick every metadata file you found.',
        'Under each other file, select **Choose file** and pick it. Skip any you do not have.',
        'Select **Preview what will be imported**. Check the **Found** list, where each file is named by its kind.',
        'Read the notes. They list attributes with no Pons Identity match and any AND or NOT rules, which are not translated.',
        'Open **SAML service providers**, untick any you do not want, and select **Import**.',
      ] },
      { heading: 'After the import' },
      { steps: [
        'Open each new application and check its entity ID and endpoints. They came from the metadata.',
        'Give the application Pons Identity\'s metadata (IdP metadata on the application page). Each application has its own certificate, so the Shibboleth signing key does not carry over.',
        'Under **User access**, choose who may sign in, then turn the application on.',
        'Connect the directory Shibboleth used under **External systems → Directories**, so people can keep signing in.',
      ] },
      { tip: 'Move one service at a time, and keep Shibboleth running until each application works with Pons Identity.' },
    ],
  },
  {
    slug: 'migrate-from-okta',
    section: 'Setup and migration',
    title: 'Migrate from Okta',
    summary: 'Bring Okta users, groups and applications over to Pons Identity.',
    visible: migrate,
    body: [
      'Okta exports users as a CSV, and its API gives you groups and applications as JSON. Passwords are never exported, so people set a new one after the move.',
      { heading: 'Find the files' },
      { bullets: [
        '**Users** (needed). In the Okta admin console, open **Directory**, then **People**, then **More actions**, and choose **Export**. That gives a CSV. You can also use the JSON from `GET /api/v1/users`. A CSV is the simplest choice.',
        '**Groups**. The JSON from `GET /api/v1/groups`.',
        '**Applications**. The JSON from `GET /api/v1/apps`.',
      ] },
      { tip: 'You need an API token with read access to use the API. In the admin console, open **Security**, then **API**, and create one. Copy it straight into your request, since Okta shows it only once.' },
      { tip: 'The API returns results a page at a time, and each page is its own list. Join the pages into one list before you upload it: `[ ...page1, ...page2 ]`.' },
      { tip: 'The group list from the API does not include members. Import the groups, then add their members in Pons Identity. If you want them in the file, add each group\'s users from `GET /api/v1/groups/{id}/users` under a `members` list.' },
      { heading: 'Import' },
      { steps: [
        'Open **Settings**, select the **Migration** tab, and set **Coming from** to **Okta**.',
        'Under **Usernames**, choose **Use the part before the @**. Okta logins are usually email addresses, and most people expect the short name.',
        'Under **Users**, select **Choose file** and pick your users file. Then add **Groups** and **Applications** the same way, if you have them.',
        'Select **Preview what will be imported**.',
        'Check the **Users** list. An account marked **inactive** came from a suspended or deprovisioned Okta user.',
        'Select **Import**. Users come first, then groups and their members, then applications.',
      ] },
      { heading: 'What does not carry over' },
      { bullets: [
        '**Built-in groups**, such as Everyone, are skipped.',
        '**SAML 1.1 and browser plugin applications** are not imported. The notes name each one.',
        '**Attribute statements built from expressions** are reported, not translated. Map those attributes by hand on the application.',
      ] },
      { heading: 'After the import' },
      { steps: [
        'Give each SAML application Pons Identity\'s metadata, and check its audience and ACS URL.',
        'For each OpenID Connect or OAuth application, copy the new **Client ID** from the result page and update the app. Confidential apps also need the **Client secret**, which is shown once.',
        'Set **User access** and turn each application on.',
      ] },
      { warning: 'Imported applications start turned off. Turn each one on only after its new client ID or metadata is in place, or people will see sign-in errors.' },
      'Not sure where a file goes? The [general migration guide](/help/migrate-from-another-provider) shows the whole flow.',
    ],
  },
  {
    slug: 'migrate-from-microsoft',
    section: 'Setup and migration',
    title: 'Migrate from Microsoft',
    summary: 'Bring users, groups and applications over from Entra ID, Active Directory or AD FS.',
    visible: migrate,
    body: [
      'Microsoft has three sources: Entra ID (the cloud directory), Active Directory on your own servers, and AD FS, which still signs people in for some applications. You can import from any of them, in one batch. Each file has its own slot on the Migration tab.',
      { heading: 'Find the files' },
      { bullets: [
        '**Users** (needed). In the Entra admin center, open **Users**, then **Bulk operations**, and choose **Bulk download** for a CSV. For Active Directory, run `Get-ADUser -Filter * -Properties DisplayName, GivenName, Surname, EmailAddress, UserPrincipalName, SamAccountName, Department, Title | Export-Csv -Path users.csv -NoTypeInformation`.',
        '**Groups**. For Entra ID, the JSON from Microsoft Graph at `GET /v1.0/groups?$expand=members`. For Active Directory, run `Get-ADGroup -Filter * -Properties Description, Members, MemberOf | ConvertTo-Json -Depth 3 | Out-File groups.json`.',
        '**Enterprise applications**. The JSON from `GET /v1.0/servicePrincipals`.',
        '**App registrations**. The JSON from `GET /v1.0/applications`.',
        '**AD FS relying party trusts**. On the AD FS server, run `Get-AdfsRelyingPartyTrust | ConvertTo-Json -Depth 5 | Out-File adfs-trusts.json`.',
      ] },
      { tip: 'Microsoft Graph needs a token that can read users, groups and applications. Microsoft Graph Explorer can run each request and save the result for you.' },
      { tip: 'Graph returns results a page at a time. Each page ends with an `@odata.nextLink`. Join the `value` lists from every page into one list before you upload it.' },
      { tip: 'PowerShell saves files as UTF-16 by default. Pons Identity reads that, so you do not need to convert them.' },
      { heading: 'Import' },
      { steps: [
        'Open **Settings**, select the **Migration** tab, and set **Coming from** to **Microsoft (Entra ID, AD FS, Active Directory)**.',
        'Under **Usernames**, choose **Use the part before the @** if your users sign in with a short name, such as `ccole`. Otherwise keep the whole principal name.',
        'Under each file, select **Choose file** (or **Add files** for groups and users, which take several). Skip any you do not have.',
        'Select **Preview what will be imported**.',
        'Check the **Groups** list. Nested groups appear under **Nested in**.',
        'Select **Import**.',
      ] },
      { heading: 'What does not carry over' },
      { bullets: [
        '**Passwords** are never exported. People set a new one with password recovery.',
        '**Entra does not export attribute mappings.** An imported SAML application starts with the usual email and name attributes; add the rest on the application.',
        '**AD FS claim rules** are read for attribute names only. Rules that compute a value, such as a regular expression or a group claim, are reported for you to rebuild.',
        '**WS-Federation only** trusts and **Entra apps without single sign-on** are skipped and listed in the notes.',
      ] },
      { heading: 'After the import' },
      { steps: [
        'Give each SAML application Pons Identity\'s metadata and check its ACS URL and entity ID.',
        'For each Entra app registration, copy the new **Client ID** from the result page and update the app. Copy any **Client secret** before you leave the page, since it is shown once.',
        'Set **User access** and turn each application on.',
      ] },
      { tip: 'Keep the Entra or AD FS sign-in running until each application works with Pons Identity. Then retire the old trust.' },
      'Not sure where a file goes? The [general migration guide](/help/migrate-from-another-provider) shows the whole flow.',
    ],
  },
];
