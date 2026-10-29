# Pons Identity
Simple SAML 2.0, CAS, OpenID Connect and OAuth 2.0 IdP (Express + SQLite via `node:sqlite`, Node 22+).

    npm install
    npm run build:web  # builds the React + Material UI front-end into web/dist
    npm start          # first start: prints a one-time setup token; open /setup and follow the wizard (or set ADMIN_PASSWORD to skip it)
    npm test           # server tests
    npm run test:web   # front-end tests

The sign-in screens and admin console are a React app in `web/`, talking to the JSON API under `/api`.
SAML protocol pages (the auto-submitting SSO response and the sign-out page) are still server-rendered.

Front-end development: run `npm start` and `npm run dev:web`, then open the Vite address. Vite proxies `/api`, `/saml` and `/logout` to the IdP on `https://localhost:3443`.

Roles and permissions: **Admin > Settings** has one tab per category (Roles & permissions, Branding and so on); Duo MFA is under **External systems**. A tab shows only for people who hold its permission. A role is a set of permissions (view/manage for users, groups, service providers and roles; configure Duo; configure log forwarding; configure branding) and people are added to roles from the role itself or from the user edit page. The built-in **Administrator** role always holds every permission and cannot be edited or deleted; the initial `admin` account has it. On first start the console also creates nine job roles, which are ordinary roles afterwards (edit or delete them as needed; a deleted one is not recreated): **Helpdesk**, **Identity administrator**, **SSO administrator**, **Integration developer**, **Report viewer**, **Federation administrator**, **Directory administrator**, **Policy author** and **Read-only** (every *View* permission). You can only grant, change or revoke permissions you hold yourself, cannot edit a user with more access than you, and cannot remove your own access.

**Policies → Sign-in policies** (needs *View policies* / *Manage policies*; the Policies module is its own entry in the console menu, with Application policies and Password policies as its other tabs) sets sign-in and password rules for everyone holding a role or belonging to a group (local, Grouper or directory, including nested groups). A policy targets one role or one group and can *require an authenticator* (people without one are taken through setup at their next sign-in and cannot remove it), attach a *password policy* (see below), or *block sign-in* (also stops single sign-on from an existing session). When several policies apply to a person the strictest value of each rule wins, so joining a group can only tighten someone's rules. Blocking can never newly block you, any administrator, or anyone with more access than you. Federated (InCommon) sign-in honors blocking too, and "require an authenticator" is met only if the institution reports multi-factor authentication.

**Global policy.** The same page can hold one **global policy**, which applies to every account and takes part in the same strictest-wins merge. It can set the sign-in and password rules except blocking. A policy for a role or group may be less strict than the global policy on a rule only with an explicit acceptance that it reduces security; the acceptance records who gave it and when, and the policy is flagged in the list. The override applies only while the global value it was accepted against is unchanged. If the global rule changes, the override stops and the stricter global value applies again until the policy is reviewed. The global password rules are set on the Password policies tab, with every password setting the named password policies have, and apply to every account. The global policy can also point at one named password policy, which cannot be deleted while it is in use. Changes to the global policy are audited as `global_policy.update/delete`.

**Settings → Password policies** (same permissions as Policies) defines reusable sets of password rules; choose one in a policy's *Password policy* field to apply it to a role or group. A password policy can set:

- **Length and complexity:** a minimum length (everyone has a built-in minimum of 12, which an administrator can overwrite in the global password rules, with a warning; a password policy can only raise it), required lowercase / uppercase / digit / symbol, and "at least N of the 4 character types".
- **Restrictions:** restricted words (case-insensitive, matched anywhere in the password), restricted patterns (regular expressions, one per line; write `/pattern/i` to set flags, otherwise case-sensitive), and an option to refuse passwords containing the person's name, username or email address. People are told that a word or pattern is restricted but never which one. Patterns with nested quantifiers such as `(a+)+` are refused when saved, and passwords are limited to 256 characters.
- **Reuse:** refuse the last N passwords (up to 24; the current one counts), or *never allow reuse*. Hashes of earlier passwords are kept for each person (the newest 100), starting from when this feature is first used, so "never" cannot see passwords set before then, other than the current one.
- **Compromised passwords:** refuse passwords found in HaveIBeenPwned, at or above a count you choose. Only the first five characters of the password's SHA-1 are sent to `api.pwnedpasswords.com` (set `HIBP_API_URL` to use a mirror). It runs last, so a password already refused for another reason is never sent. If the service is unreachable the check is skipped, unless the policy says to refuse the password in that case.
- **Strength (zxcvbn):** turn the strength estimate on or off. When on, people see a bar (Very weak, Weak, Fair, Good, Strong) with advice while they type a new password on their profile page, and administrators see it when setting someone's password. A minimum strength makes the server refuse anything weaker; "show the bar only" never refuses. The bar is advisory and the server makes the real decision.

When several password policies apply to a person the strictest value of each rule wins. A password policy that is in use cannot be deleted. Rules are enforced whenever a password is set: on the profile page, in the console, by password recovery, and through the user API, bulk imports and the directory API. A new account is held to the policies of the groups it is created in, since it has no policies of its own until it exists. When setting a password, administrators and people changing their own can use **Generate a passphrase**, which offers random words from the EFF wordlist with a choice of word count (3 to 8), separator, capital letters, and a two-digit number added to the end of one random word. Words that would spell an offensive term when run together are never offered. People can read their own rules at `GET /api/account/password-rules`. Changes are audited as `password_policy.create/update/delete`.


**Policies → Compromised accounts** (needs *View policies* / *Manage policies*) sets what a lockdown does when an account may have been used by someone else. An account's page has a **Compromised account** card with **Lock down account** and **End lockdown**. The same actions are available to other software through `POST /api/v1/users/{id}/lockdown` and `DELETE /api/v1/users/{id}/lockdown` (scope `users:write`); each lockdown call fires the integration event **An account was locked down**. A lockdown runs the built-in **Compromised account lockdown** integration, so its procedure can be read and changed under **Integrations**. It cannot be deleted, only turned off; **Restore original** on its page puts back the built-in name, script, scopes and inputs, and keeps its schedules, events and on/off setting. The steps are: sign out everywhere, replace the password, remove sign-in methods, forget remembered browsers, turn the account off, limit sign-in to listed networks, and tell the person. The **Everyone** policy sets the steps for every account (with no Everyone policy, the built-in default applies: every step except the network limit). A role or group policy adds steps for the people in it, and every network list any of them sets must match the address a person signs in from. While an account is in lockdown, sign-in from outside its networks is refused the same way as a block. Ending a lockdown turns the account back on if the lockdown turned it off; the password and sign-in methods are not restored. The API reference is served at `/api/v1/docs` and described in `docs/openapi.yaml`.

**Policies → Policy calculator** (needs *View policies*) says which policies are enforced in a situation. Choose a **person** to see the sign-in policies that apply to them (the global policy, and those for each role and group they have, with the route that puts them in each group), the strictest value of every rule and which policies set it, the password rules, and the compromised-account lockdown steps. Choose an **application** (SAML, OpenID Connect, OAuth 2.0 or CAS) to see who may use it and the application policies that cover it. Choose **both** to also see whether that person would be allowed, asked for a second factor first, or refused, and why. It uses the same code that enforces policies at sign-in, so the answer matches what would really happen. Naming a person also needs *View users*, and an application *View service providers*. The answer comes as **Text** and as an interactive diagram (Mermaid), drawn either **Horizontal** (left to right) or **Vertical** (top to bottom): click a box to open it, point at one to trace what connects to it, zoom, download as SVG, or copy the Mermaid source. A person whose account is turned off has a warning in their box. The same endpoint is `GET /api/admin/calculators/policy?user_id=&kind=app|sp&app_id=`.

**Guest accounts** (*Guest accounts* in the profile menu) let a person **host** guests. **Policies → Guest accounts** (needs *View policies* / *Manage policies*) chooses the groups whose members may host, including through nested groups; with none chosen nobody can, and someone who leaves every chosen group keeps their guests and can see and remove them but not add or change them. A guest is a person with their own sign-in: people who get their own sign-in. A new guest holds no roles and so no permissions, only a login. The host may give a guest roles, but only roles whose permissions the host holds in full. The cap is applied every time access is checked (`roles.permissionsOf`), so a guest also loses anything the host loses, including roles granted another way, and holds nothing while the host is deactivated (a guest cannot sign in then either). Every guest has an **expiry date and time**, required when the guest is created and no further away than the longest an administrator allows (set on **Policies → Guest accounts**, a number of days from now; 14 by default). When it passes the guest is signed out everywhere, can no longer sign in and holds no permissions, and the account is turned off by a job that runs every minute; the host can give it more time, which turns it back on. A new guest's password is generated for the host (four words, with capitals, a number and hyphens, from the same generator as the password forms) and cannot be typed; the host can regenerate it before inviting and is shown it once afterwards to pass on. Hosts reach this page from **Guest accounts** in the profile menu at the top right. Guests cannot host guests (and so never see *My guests*), a host can have as many as the largest limit set for the groups they belong to (**Policies → Guest accounts** sets a limit of 1–1000, 25 by default, for each chosen group; lowering it never removes guests), and deleting a host deletes their guests. Hosts can disable, re-enable, reset the password of, or remove their guests; administrators with *Manage users* see and edit guests like any account (a guest's account page shows its host). Creating, changing and removing guests is recorded in the audit log (`guest.create`, `guest.update`, `guest.delete`). API: `GET/POST /api/my/guests`, `PUT/DELETE /api/my/guests/{id}`.

Branding has a **Name propagation** switch, on by default. On, the product name is used everywhere the product is named (messages, help and generated files); off, those keep the default name, and only the header, sign-in page and browser title use the name you chose. A blank name means the default.

Duo and branding are edited on the Settings page and stored in the database. A saved Duo configuration replaces `duo*` from `config.json`/environment (which stay the fallback until one is saved). Turning Duo on first checks the keys with Duo. If Duo is ever misconfigured and nobody can sign in, run `DELETE FROM settings WHERE key = 'duo'` against the database to fall back to the file settings.

Each application (service provider) is edited on a single admin page (`/admin/sps/:id`): name, IdP metadata to hand over, SP metadata (manual, URL or upload), SAML response options (NameID, signing, assertion encryption, attribute mapping, role attributes) and attribute transformations.

**Applications** (*Admin → Applications → New application*) can be SAML 2.0, CAS, OpenID Connect or OAuth 2.0. They share the *service providers* permissions and the same user-access rules (disabled, certain groups, everyone). The non-SAML kinds are edited on `/admin/apps/:id`:

| Kind | Endpoints | Notes |
| --- | --- | --- |
| OpenID Connect | `/oidc/.well-known/openid-configuration`, `/oidc/authorize`, `/oidc/token`, `/oidc/userinfo`, `/oidc/jwks`, `/oidc/introspect`, `/oidc/revoke`, `/oidc/logout` | Authorization code with PKCE (S256), refresh tokens (`offline_access`), RS256 ID tokens signed by a key generated on first use. Scopes `openid profile email groups`; extra claims are mapped from IdP attributes. |
| OAuth 2.0 | `/oauth2/.well-known/oauth-authorization-server`, `/oauth2/authorize`, `/oauth2/token`, `/oauth2/userinfo`, `/oauth2/introspect`, `/oauth2/revoke` | Authorization code with PKCE, refresh tokens, and client credentials for service-to-service calls. Scopes are whatever the administrator lists. |
| CAS | `/cas/login`, `/cas/logout`, `/cas/validate` (1.0), `/cas/serviceValidate` (2.0), `/cas/p3/serviceValidate` (3.0, with attributes) | Services are exact URLs or a path ending in `*`. Tickets are single-use, valid for five minutes and bound to the service they were issued for. `renew` and `gateway` are honoured. |

A new application's client ID (reserved for it) and endpoints are shown as soon as the *New application* page opens, so they can be copied into the other system before the first save. Confidential clients get a client secret that is shown once, when the application is created or the secret replaced; only its hash is stored. Public clients (no secret) must use PKCE. Redirect URIs match exactly. There is no consent screen because every client is registered by an administrator. CAS single logout (back-channel notification) and proxy tickets are not implemented.

Transformation rules are one `attribute = expression` per line, applied after the mappings (functions: `lower upper trim concat replace extract split substring coalesce join first attr drop`). The page previews the result for a chosen user. Users also carry Active Directory attributes (userPrincipalName, sAMAccountName, DN, manager, etc.) that can be mapped or used as the NameID.

## First-run setup wizard

When Pons Identity starts with a database that has no users, it opens a **setup wizard** at `/setup` (every address redirects there). It creates the first administrator, sets the product name, color and session limits, and can import from another identity provider (see Migration below).

**One-time token.** Anyone who can reach the port could otherwise claim a brand-new server, so every wizard request needs a token that is printed on the server's console (`docker compose logs` in a container) and held only in memory. It changes each time the server starts. Wrong guesses are counted per address and blocked after ten in 15 minutes.

**Switched off, not removed.** As soon as the administrator exists the wizard's endpoints answer `404` and the token is discarded. It stays in the product:

- A signed-in person with the **Re-run the setup wizard** permission (`setup.run`, held by the Administrator role) can open it again from **Settings → Setup wizard**. It then skips the token and the administrator step and changes only what they choose.
- If the database is ever emptied of users (data cleared, a new volume) it opens again by itself with a new token, because nobody can sign in.

Unattended installs skip it: set `ADMIN_PASSWORD` (the administrator is created as before) or `SETUP_WIZARD=false` / `"setupWizard": false`. An install that already has users when upgraded never shows it.

## Migrating from another identity provider

**Settings → Migration** (permission `migration.manage`) and the wizard's *Import* step read what you exported, show what was found, and only then create it. Each file has its own upload slot, so you say what each file is. Nothing is overwritten: users, groups and applications that already exist are skipped.

| From | Files |
| --- | --- |
| Shibboleth IdP | Service-provider metadata (one entity or a federation's), `attribute-resolver.xml` and `attribute-filter.xml` (what each service provider is released, mapped to Pons Identity attributes), `relying-party.xml` (signing and encryption overrides), `idp.properties` / `ldap.properties` (notes for the cut-over). Shibboleth keeps no users; connect the same LDAP under External systems. |
| Okta | Users (CSV export or API JSON), groups JSON (members under `members`), applications JSON (SAML 2.0 with attribute statements, OpenID Connect). |
| Microsoft | Entra ID users (portal CSV or Graph JSON), groups with nesting, enterprise applications (SAML) and app registrations (OpenID Connect); Active Directory `Get-ADUser` / `Get-ADGroup` exports; AD FS `Get-AdfsRelyingPartyTrust \| ConvertTo-Json` (endpoints and claim-rule attribute names). UTF-16 files from PowerShell are read. |
| Anything else | Users CSV (columns such as login, email, first/last name, department), groups CSV, group-membership CSV (`group,member`), and SAML SP metadata XML. |

Imported users get a password nobody knows (they use password recovery, or you set one), and can be named by their whole login or the part before the `@`. Group nesting becomes nested groups. **Applications are created turned off** unless you tick the box, so nothing signs people in before each has been reviewed; OpenID Connect applications get new client IDs and (if confidential) a new secret, shown once on the result page. Things that cannot be carried over (attribute rules that compute values, WS-Federation, password-replay apps) are listed in the preview.

## Exporting data

**Settings → Export** (permission `export.manage`, plus the matching view permission for each part) downloads configuration (settings, roles, policies, attribute definitions, applications, directories), users, groups with their folders, nesting, rules and members, and integrations with their scripts, functions and variables, as one JSON file or a zip of one file per part with a `users.csv`. Password hashes, second-factor secrets, private keys, client secrets, tokens and secret variable values are never included; each download is audited (`export.download`). It is a record, not a backup.

## Search

The dashboard is the home page for administrators; people without console access go to their groups or profile.

The **Search** button in the console header (or Ctrl+K / ⌘K) opens a search over the whole console: it dims and blurs the page behind it and lists matches for people, applications, groups, integrations and the audit log, each only if the signed-in administrator may open that area, and for the help articles that person may read (under **Documentation**). Choose a result with the arrow keys and Enter, or **See all** to open that list searched with the same text.

The audit log and sign-in log filters (action, actor, address, person, country, network) are searchable lists that offer only values that occur in the log, most frequent first.

Each list page has its own search box as well: **Users**, **Applications**, **Groups** and **Integrations** (and the audit log's search fields on **Audit**). Free text matches every word you type against the name, username, email, employee ID, department, title and similar fields.

**People search also takes LDAP filters**: when the text starts with `(`, it is read as an RFC 4515 filter, the same syntax a directory search uses, and matched against the people in this IdP. Examples:

- `(&(department=Underwater Basket-Weaving)(mail=*))`: people in Underwater Basket-Weaving with an address
- `(|(uid=sam)(sAMAccountName=sam))`, `(cn=*Adams)`, `(!(c=GB))`, `(memberOf=underwater-basket-weaving-staff)`

Equality, `*` wildcards (`(cn=al*)`, `(mail=*@example.net)`), presence (`=*`), `>=`, `<=`, `~=`, and `&`, `|`, `!` are supported. Attributes are matched case-insensitively against: `uid`, `cn`, `displayName`, `givenName`, `sn`, `mail` (every address), `mailNickname`, `memberOf` (group names), `employeeNumber`, `department`, `title`, `telephoneNumber`, `mobile`, `company`, `manager`, `physicalDeliveryOfficeName`, `streetAddress`, `l`, `st`, `postalCode`, `c`, `description`, `sAMAccountName`, `userPrincipalName`, `distinguishedName` and `entryUUID`. An unknown attribute or a malformed filter is reported rather than matching nothing. Escape a literal `*`, `(`, `)` or `\` as `\2a`, `\28`, `\29` or `\5c`.

### LDAP query builder

Wherever a field takes an LDAP query (people search on **Users** and in the global search, a group's membership query, and a directory's user search filter) there is a **Query builder** button. It opens a dialog where each condition is an attribute, a comparison (equals, contains, starts or ends with, has a value, at least, at most, sounds like, and their negations) and a value, joined by *all of* or *any of*. The query is written for you with values escaped, can be edited by hand, and is checked by the server as you type: the syntax, the attribute names (for people filters) and how many people match. A directory filter is checked for syntax only, and may contain `{username}`.

### Group membership

A group's members are shown as **Direct** (added to the group, by hand or by its query), **Indirect** (in through a nested group or a composite) or **Direct, Indirect** (both), with a note naming the nested group or saying the group's query added them. A person's own page lists their groups the same way. Members are added from a combobox you can search by typing.

**Groups → Group calculator** (the button on the Groups page; needs *View groups*) explains membership in two directions. Choose a **person and a group** to see every route that put the person in the group (their own membership, a query, a nested group, either factor of a composite, an include group) or, if they are not in it, what keeps them out (an ended membership, the other side of an intersection, a difference, an exclude group). Choose a **person** alone to list all their groups and the routes into each. Choose a **group** alone to see how it is built: direct members, query, nested groups, composite factors, include and exclude groups and the groups those use in turn, followed by what the group is used by (groups, policies, applications, roles). Like the Policy calculator it gives a **Text** view and **Horizontal** and **Vertical** diagram views, and the endpoint is `GET /api/admin/calculators/group?user_id=&group_id=`. Both calculators only read; they change nothing and write no audit entries.

A local group can also take its members from an **LDAP query** over the people in this IdP (its **Membership query** tab). *Snapshot* runs it once, when asked, and adds whoever matches as ordinary members. *Ongoing* re-runs it every few minutes and after people change, adding people who start to match and removing those it added who stop; people added by hand are never removed by it. Removing the query keeps the people it added. Composite groups and groups managed by Grouper or a directory cannot use a query.

## Audit log

Pons Identity keeps an append-only record of what happens in it, in the `audit_log` table. Each event has a category, an action, an outcome, who did it (a user, an integration, or the system), what it was done to, the client IP and user agent, and a request id that ties together everything one request caused.

| Category | Examples |
| --- | --- |
| `system` | `system.start`, `system.stop`, `admin.seed`, `tls.generate`, `federation.refresh`, `grouper.push.finish`, `audit.prune` |
| `admin` | `user.create/update/delete`, `user.password_reset`, `user.sessions_end`, `user.lockdown`, `user.lockdown_restrict`, `user.lockdown_end`, `compromise_policy.*`, `service_account.lockdown`, `service_account.lockdown_end`, `user.totp_reset`, `role.*`, `policy.*`, `password_policy.*`, `sp.create/update/delete`, `app.create/update/delete`, `app.secret.rotate`, `sp.cert.regenerate`, `group.*`, `settings.duo/branding/grouper/messaging/message_templates`, `token.*.create/delete`, `federation.*` (sources, settings, identities, `federation.key.stage/activate/retire`), `directory.*` (including `directory.script_*`), `provisioning.*`, `scim.write`, `directory_api.write`, `access.denied`, `audit.export` |
| `user` | `login.success`, `login.failure`, `mfa.failure`, `mfa.enroll/enable/disable`, `password.change`, `logout`, `slo.sp_initiated`, `sso.assertion_issued`, `sso.denied`, `token.issue`, `federated_login.*`, `identity.provisioned`, `user.auto_provision`, `token.auth_failure`, `sso.app_policy`, `mfa.remember_cleared` |

Failures are recorded too (`outcome` is `failure`): wrong passwords (with the reason, such as `unknown_user` or `inactive`, which the person signing in is never told), bad MFA codes, rejected bearer tokens and refused admin actions. Admin events list which fields changed, not their values. Passwords, TOTP secrets, tokens, Duo and directory secrets are never stored or forwarded; anything in an event's detail whose key looks like a credential is replaced with `[redacted]`.

Administrators with the **View audit log** permission (`audit.view`) get an **Audit** page in the console to search by category, outcome, action, actor, text and date, read each event's details, and export the result as CSV. Group changes also still appear on each group's own history.

### Sending events to a log server or SIEM

The local table is the source of truth; forwarding ships a copy. Each destination remembers how far it has got, so events are delivered in order, retried with backoff when the receiver is down, and replayed after a restart (at least once: every event carries a stable `id` for de-duplication). A slow or dead receiver never delays or fails a request, and the Audit page shows each destination's health with a **Send test event** button.

Configure destinations in **Settings › Log forwarding** (needs **Configure log forwarding**, `audit.manage`). Syslog and SIEM destinations are set only there; they are stored in the database, access token included, the same way Duo's secret key is stored. `config.json` and environment variables do not configure them. `auditStdout` is the one forwarding option still set in `config.json`:

```json
{
  "auditStdout": false
}
```

- **Syslog** (`udp://`, `tcp://` or `tls://host:port`): RFC 5424 messages with the event as structured data and JSON as the message; TCP and TLS use RFC 6587 octet-counting. Failures are sent as severity `warning`, everything else as `informational`. Works with rsyslog, syslog-ng, Graylog and most SIEM collectors.
- **HTTP** (`auditHttp.format`): `json` (an array of events), `splunk-hec` (Splunk HTTP Event Collector, `Authorization: Splunk <token>`), `ecs` (Elastic Common Schema, for Elastic, OpenSearch or Logstash) or `cef` (ArcSight-style lines). The access token is sent as a bearer token unless the format needs another scheme. The console does not set other request headers.
- **stdout** (`auditStdout: true`): one JSON line per event, for Docker, Fluent Bit or Vector.

Use `tls://` or `https://` whenever the log server is not on the same trusted network: events contain usernames and IP addresses.

## Message templates

Administrators with **Configure messaging** (`messaging.manage`) can edit the wording of the messages the IdP sends, under **Settings → Message templates**. There are five message types: **Sign-in verification code**, **Number matching**, **Yes or no (unverified)**, **Yes or no (verified)** and **Password reset**. Each has its own email (subject and body), SMS and voice-call text, and the sign-in ones say what the person sends back (see [Sign-in factors](#sign-in-factors)). Delivery (SMTP, SendGrid, Amazon SES, Postmark, Mailgun, Twilio, custom HTTP) is configured separately on the Messaging tab. Until you save a change, the built-in wording is used. **Reset to default wording** restores it for one message.

Templates are plain text. Put a variable in double braces, for example `Your code is {{code}}`; spaces inside the braces (`{{ code }}`) are allowed, names are case-sensitive, and the console rejects a template that uses an unknown variable, uses one where it is not available, or leaves out the code or link the person needs. Each editor has buttons that insert variables and a preview filled with sample values.

| Variable | Contents | Available in |
| --- | --- | --- |
| `{{code}}` | The one-time code, e.g. `482913` | both message types; email, SMS, voice |
| `{{codeSpoken}}` | The code with its digits separated so a call reads them one by one (`4, 8, 2, 9, 1, 3`). Use it instead of `{{code}}` in voice messages | both; email, SMS, voice |
| `{{link}}` | Single-use address where the person chooses a new password | Password reset; email and SMS only (a call cannot carry a link) |
| `{{username}}` | The person's username | both; all channels |
| `{{displayName}}` | The person's display name, or their username if they have none | both; all channels |
| `{{appName}}` | The product name from Branding (see Name propagation) | both; all channels |
| `{{expiresInMinutes}}` | Minutes the code or link stays valid, as a number | both; all channels |

Required content: a verification code message must contain `{{code}}` (voice: `{{codeSpoken}}`); a password reset by email or SMS must contain `{{link}}` or `{{code}}`; a reset by voice must contain `{{codeSpoken}}`. Limits: subject 200 characters, email body 5000, SMS and voice 1000 (SMS over 160 characters is billed as several messages by most providers). Line breaks in variable values are collapsed so a value can never add email headers. Changes are audited as `settings.message_templates` with the list of messages changed.

API: `GET`/`PUT /api/admin/settings/messaging/templates` (the GET response includes the variable reference) and `POST /api/admin/settings/messaging/templates/preview`. Code that sends one of these messages calls `messaging.sendTemplated(kind, channel, to, vars)` with `kind` `mfa` or `passwordReset`; the wording is looked up at send time.

## Internet2 Grouper

Grouper provisions groups and memberships to Pons Identity over SCIM 2.0, and each application can release a user's Grouper groups in a SAML attribute.

1. In the console open **Grouper** (needs the *Configure Grouper* permission), create a provisioning token (shown once; only a hash is stored), choose the **group attribute name** (`isMemberOf`, `memberOf`, `groups`, a URN, or anything else), and enable the integration.
2. In Grouper, add a SCIM 2.0 provisioning target with base URL `https://<idp>/scim/v2` and that token as the bearer token. Group `displayName` (the Grouper group name, e.g. `ref:affiliation:staff`) becomes the SAML attribute value.
3. On each application's page tick **Release Grouper groups**. Nothing is released to applications that do not opt in, or while the integration is disabled.

How it behaves:

* SCIM serves `Groups` (create, read, filter by `displayName`/`externalId`, `PUT`, `PATCH` add/remove/replace members, delete) and read-only `Users` (filter by `userName`). Users are never created or changed over SCIM.
* Members are matched to existing users by SCIM id (the user's GUID) or username; members that match nobody are skipped and counted in the Grouper status panel.
* Grouper groups are separate from console groups: console groups are invisible to SCIM, Grouper groups are read-only in the console (name and members), and saving a user never alters their Grouper memberships. Grouper groups can still be used for application access and role mappings.
* **Override (pinned members):** on a Grouper group's page an administrator can pin users. A pinned membership can't be added, replaced or removed by Grouper, whether through `PUT`, `PATCH` or deleting the group, so it keeps working if a sync goes wrong. Grouper only sees the members it provided. If Grouper deletes a group that still has pinned members, the group stays (and is taken back when Grouper recreates it). Unpinning removes the membership unless Grouper also provides it. Pinning into a group that is mapped to a role needs the permissions of that role.
* **Override (pinned members):** on a Grouper group's page an administrator can pin users. A pinned membership can't be added, replaced or removed by Grouper, whether through `PUT`, `PATCH` or deleting the group, so it keeps working if a sync goes wrong. Grouper only sees the members it provided. If Grouper deletes a group that still has pinned members, the group stays (and is taken back when Grouper recreates it). Unpinning removes the membership unless Grouper also provides it. Pinning into a group that is mapped to a role needs the permissions of that role.
* **Role mapping:** in the Grouper settings tab, map a Grouper group name (e.g. `ref:it:admins`) to an IdP role. Members get that role on top of the roles assigned in the console, and lose it as soon as Grouper removes them or the integration is disabled. Granted roles are never stored as console assignments, so saving a user doesn't make them permanent. To guard against lockout, pin a break-glass administrator into the mapped group. To guard against lockout, pin a break-glass administrator into the mapped group. Changing mappings needs *Manage roles*, and you can only map roles whose permissions you hold yourself. Map the Administrator role with care: anyone Grouper puts in that group becomes an administrator.
* Pick `Grouper group names` in the attribute mapping or transformation rules to use them like any other multi-valued attribute.

## Group folders and external group management

**Folders.** *Admin > Groups* shows groups in a tree of folders. Drag a group or folder onto a folder to file it there, onto the upper or lower edge of a row to place it before or after that row, or onto "Drop here to move to the top level" (shown while dragging). Every row also has an **Actions** menu with **Move to…** for keyboard and touch use, and folders can be renamed, given subfolders, or deleted (their groups and subfolders move up one level; nothing else is deleted). Folders only *file* groups: a group's name, members and what it grants do not depend on where it sits, so Grouper and directory groups can be filed too. Changing folders needs *Manage groups*; folder names are unique among siblings and cannot contain `/`. Moves appear in the group's history and the audit log (`group.move`, `group.folder.*`).

Software that works with groups outside the console has two routes. Both apply the same rules as the console: only local groups are edited, a composite takes no direct members, nesting and folder moves cannot make loops, and every change is audited.

**Group managers and attestation.** Each group can have one or more *group managers*. A manager has update access to that group (adds and removes members, sets dates) and can attest that its membership is still right. An administrator, or anyone with admin access to the group, appoints managers under the group's **Managers & attestation** tab. The same people can set the attestation **frequency** (monthly, quarterly or annually) and the first due date; later due dates move on one period from each attestation, and a due-soon or overdue status shows on the tab. Attesting records who the members were at that moment, with an optional note, in the attestation history, and in the group's history and the audit log (`manager.add`, `manager.remove`, `attestation.schedule`, `attestation.complete`). Only managers and people with admin access can attest; readers and updaters see the schedule but cannot attest. Administrators see every scheduled group, soonest due first, at `GET /api/admin/groups/attestations`. Group managers are not granted roles, and only local groups are changed; an externally managed group can have managers and an attestation schedule too.

### Group management API

Create a token in **API > Group API** (needs *Configure the group API*): a name and either *read only* or *read and write*. The token is shown once and only its hash is stored. A token reaches every group, so treat it like an administrator credential. Base URL `https://<idp>/group-api/v1`; send `Authorization: Bearer <token>`. Changes made with a token are attributed to `group-api:<token name>`.

| Method and path | Purpose |
| --- | --- |
| `GET /tree` | All folders (nested to any depth) and the groups in each |
| `GET /folders[?parent_id=<id or none>]`, `GET /folders/:id` | List or read folders |
| `POST /folders` | `{ "name", "description"?, "parent_id"?, "before_id"? }` |
| `PATCH /folders/:id` | `name`, `description`, or move with `parent_id` (`null` = top level) and `before_id` (place before that sibling; omit to place last) |
| `DELETE /folders/:id` | Contents move up one level |
| `GET /groups[?folder_id=<id or none>&name=&source=&q=&limit=&offset=]`, `GET /groups/:id` | List or read groups |
| `POST /groups` | `{ "name", "description"?, "folder_id"?, "before_id"? }` |
| `PATCH /groups/:id` | `name`/`description` (local groups only) and `folder_id`/`before_id` (any group) |
| `DELETE /groups/:id` | Local groups only |
| `GET /groups/:id/members`, `GET /groups/:id/effective-members` | Direct members; or everyone including nested groups and composites |
| `POST /groups/:id/members` | `{ "users": ["sam", 42] }` by username or user id; reports `added` and `unknown` |
| `DELETE /groups/:id/members/:user` | Username or user id |
| `GET /groups/:id/includes`, `POST /groups/:id/includes` `{ "group_id" }`, `DELETE /groups/:id/includes/:childId` | Nested groups |
| `GET /users?username=&email=&q=` | Look up people (id, username, name, email) |

Errors are `{ "error": "...", "errors": [...] }` with 400 (invalid), 401 (bad token), 403 (read-only token), 404, 409 (conflict, or a group managed in Grouper or a directory).

```sh
curl -H "Authorization: Bearer $TOKEN" https://idp.example.net/group-api/v1/tree
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"underwater-basket-weaving-staff","folder_id":2}' https://idp.example.net/group-api/v1/groups
```

### SQL interface

For software that opens the SQLite database itself (`data/idp.db`), these views are the supported contract; the tables behind them may change. They are rebuilt at every start.

| View | Columns | Writes |
| --- | --- | --- |
| `ext_group_folders` | `id, parent_id, name, description, position, path` | insert, update, delete (delete moves contents up) |
| `ext_groups` | `id, name, description, source, folder_id, folder_path, position, direct_member_count, is_composite` | insert (local), update (name/description on local groups; `folder_id`/`position` on any), delete (local) |
| `ext_group_members` | `group_id, group_name, group_source, user_id, username, start_at, end_at, active` | insert by `group_id`/`group_name` and `user_id`/`username`, update the dates, delete; local, non-composite groups |
| `ext_group_includes` | `group_id, group_name, member_group_id, member_group_name` | insert (loops refused), delete |
| `ext_group_composites` | `group_id, group_name, op, left_id, left_name, right_id, right_name` | read-only |
| `ext_users` | `id, guid, username, display_name, email, active` | read-only (no credentials) |

```sql
PRAGMA foreign_keys = ON;   -- required: writes are refused without it
PRAGMA busy_timeout = 5000;
INSERT INTO ext_group_folders (name) VALUES ('Departments');
INSERT INTO ext_groups (name, folder_id) VALUES ('underwater-basket-weaving-staff', (SELECT id FROM ext_group_folders WHERE path = 'Departments'));
INSERT INTO ext_group_members (group_name, username) VALUES ('underwater-basket-weaving-staff', 'sam');
UPDATE ext_groups SET folder_id = NULL WHERE name = 'underwater-basket-weaving-staff';          -- move to the top level
```

Notes: `start_at`/`end_at` are epoch seconds (NULL = open-ended). Omit `position` on insert to be placed last; siblings are ordered by `position`, then name (0 = never arranged). Each change is written to the group history and the audit log as actor `sql-interface`, so log forwarding picks it up. Effective membership (nesting plus composites) is not available as a view; use `GET /groups/:id/effective-members` for it. **SQLite has no per-user permissions:** anyone who can open the file can read and change everything, including credentials, regardless of these views. Use `?mode=ro` for read-only consumers and give the API, not the file, to software you would not trust with an administrator account.

## Sign-in log and risk-based sign-in

**Sign-in log.** Every step of signing in (a password check, a second-factor step, a completed or refused sign-in, a password
recovery) is recorded with the address, its place and network, the browser and kind of device, how the person verified, and the
risk score. Administrators with audit access search it on **Sign-ins** (by person, address, country, network, step, result or
risk), see one person's history on their user page, and export CSV. People see their own recent activity on their profile.
Rows are kept for the audit retention period. A browser is recognized by a signed cookie; the log keeps only a short hash of it.

**Place and network** come from MaxMind GeoLite2 database files you place on the server (nothing is sent to anyone): download
`GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` (free, with a MaxMind account) and upload them under **Settings → Risk**. Uploads are kept in the
`geoip` folder beside the database. A file kept elsewhere on the server can be used instead by giving its path there.
Without them the log shows addresses only and the signals that need a place stay quiet. Behind a proxy, set `TRUST_PROXY=true`
so the real client address is used.

**Risk.** After the password is right, the sign-in is scored from the account's own history. These signals add their weight:

| Signal | Fires when |
| --- | --- |
| Password spraying | many accounts fail from one address or network, or one account fails from many addresses, within the window |
| Impossible travel | the last sign-in was too far away to reach this one in the time between them |
| Unrecognized device | this browser has not signed in to this account before |
| New country / new network | the account has not signed in from this country or ASN before |
| Country mismatch | the sign-in country differs from the country on the profile |
| Device location | the browser's own location (asked for only if this signal is on) is far from the address's; it can only add risk |
| Sensitive group | the person is in one of the groups chosen for it (directly or through a nested group), such as the C-suite or people often targeted by phishing; it counts from the first sign-in |

A person's first sign-ins never look "new". The total decides low, medium or high, and each of the last two can lead to an action:
nothing, require a second factor, phishing-resistant factors only, security keys only, or block. Settings set the actions for
everyone; a policy can only make them stricter for its role or group. Modes: **off**, **report** (score and log, change nothing;
start here) and **enforce**. A risky sign-in is never allowed to set up a new method, since that is what a thief with the password
would do. Administrators are never locked out by a score: a block becomes "security keys only", and if that would leave them
nothing, the risk rules step aside and the audit log records `risk.admin_fallback`. **Settings → Risk** has a simulator.

## Sign-in protection and sessions

- **Guessing limits.** Failed password sign-ins are counted per typed username (10 in 15 minutes) and per client address (100), failed authenticator-app codes per account (10), and failed SFTP password logins per account and address. The counts are rows in the database (`auth_failures`), so signing in again, reconnecting or restarting does not reset them. While a limit is reached the answer is `429` with `Retry-After`, even for the right password. The cost is that someone who knows a username can keep it locked out while they keep failing; the window is short for that reason. Limits are constants in `src/throttle.js`.
- **Sessions** (Settings > Sessions). The session length (default 8 hours, counted from sign-in) and an optional idle timeout (off by default) are enforced on every request, so a change also applies to sessions already open. Saving with no idle timeout needs the warning acknowledged.
- **Risks that need acknowledging.** Saving any of these is refused (409) until the administrator ticks the warning, and the acceptance is recorded in the audit log (`settings.risk_acknowledged`) and forgotten once the setting is fixed: email replies accepted with no SPF/DKIM/DMARC requirement (Settings > Messaging > Email), unverified yes/no approval (Settings > Sign-in factors), voice call requests with Twilio signature checking off (Settings > Messaging > Voice), and no idle timeout.
- **Email replies** are trusted on the provider's own SPF, DKIM and DMARC verdicts (Amazon SES and Mailgun report them; for Postmark and others they are read from the first `Authentication-Results` / `Received-SPF` header). A required check the provider does not report counts as failed.
- **SAML logout.** A LogoutRequest from an SP with a registered signing certificate must be signed with it (HTTP-POST binding with an enveloped XML signature is recommended; signed HTTP-Redirect also works) and issued within the last ten minutes.
- **CAS service patterns** may use `*` only as the last character after a `/` that follows the host, for example `https://app.example.net/app/*`.
- **Outbound requests** (metadata, provider APIs, integration scripts) resolve the host once, refuse anything that is not a public unicast address (including IPv4 carried in IPv6 forms) and connect to that same address, so DNS cannot change the answer between the check and the connection.
- **Headers.** `helmet` sets the standard security headers; HSTS is sent when `BASE_URL` is https, also behind a TLS-terminating proxy.

## Password recovery

Someone who forgot their password can ask for a reset link on the sign-in page. It is sent to a **personal email address** (not
part of the organization's mail) that the person added on their profile and confirmed with a code, or that an administrator, a
bulk import (`personal_email` column) or the user API entered. Turn it on under **Settings → Password recovery**; it needs
email delivery under Messaging, and it is off by default.

- A link works once and for 30 minutes. Asking again voids the earlier link, at most three links are sent per account per hour,
  and changing the password any other way voids them all.
- The answer to a request is identical whether or not an account matched, so the page cannot be used to find out who has one.
  The audit log (`recovery.request`) records the real outcome and reason.
- It does not bypass a second factor, and resetting ends the person's sessions and emails a notice to the recovery address.
- Not available for accounts owned by an external directory, inactive or blocked accounts, or administrators (unless allowed in
  the settings). A policy can also turn it off for a role or group ("Turn off password recovery by personal email").
- Adding, changing or removing the address needs the current password, and the old address is told about a change.

### Identity verification

Recovery can require the person to prove who they are first. Under **Settings → Identity verification** (needs *Configure password recovery*) an administrator chooses how: **Persona**, a **REST service** described on the same page, or an **integration script**. Then they choose which resets need it: **a password reset**, and **a second-factor reset**. A second-factor reset is never offered without verification, so turning it on is what lets someone who lost their phone start one.

- **The flow.** The person follows the emailed link. If verification is required, the page offers **Verify my identity**, which starts a verification and shows the link to complete it. They come back and choose **Check again**. A password can be set, or (for a second-factor link) the second factors are removed, only once a verification has *passed* for that link. Passing means the provider said so. Nothing the person types can approve it.
- **Persona.** Set the API key, the inquiry template ID and the webhook signing secret. Each verification is an inquiry created with the person's account GUID as its reference. Persona's webhook (`/identity/webhook/persona`) is checked against its `Persona-Signature` header; a valid call only asks Persona for the inquiry's status again.
- **REST service.** Describe three calls: **create the verification** (required), **send the person's details** (optional), and **get the status** (required). Each has a method, an address, headers and a body. Any of them can use `{{user.username}}`, `{{user.email}}`, `{{user.first_name}}`, `{{user.last_name}}`, `{{user.guid}}` and `{{ref}}`. Values are encoded for an address and escaped for a JSON body, so a name cannot break the request. The create call's answer gives the reference and optionally a link; the status answer's field, compared with the values you give for approved, declined and expired, gives the status. Anything else is pending. A **callback** address lets the service report a change; the callback only asks for the status again. Headers and secrets are never sent back to the console.
- **Integration script.** Choose an integration instead of a provider, and it is run with `input.step` set to `start` (it returns `{ url, ref }`) or `check` (it returns `{ approved }`). The script can use `idp.identity.start`, `idp.identity.status` and `idp.identity.latest` with the **identity** scope, and `http`. A script's own identity calls use the configured provider, never the gate itself, so a gate cannot run itself.
- **What is kept.** Each verification is recorded with the person, its purpose, the provider, its reference and its last status (`identity.start`, `identity.result`, `identity.failure` in the audit log). A verification counts only if it passed after the link was sent and within the last day.
- **Second-factor reset.** The person asks for a link from the sign-in page (**Lost your second factor?**). After verification the page offers **Remove my second factors**. The factors are removed and the person sets up a new one at their next sign-in. It removes nothing unless the verification passed.

## Sign-in factors

Beyond the authenticator app (TOTP) and Duo, people can verify with **security keys and passkeys (FIDO2/WebAuthn)** and with
**email, SMS or a phone call**. Everything is off until an administrator enables it under **Settings → Sign-in factors**;
email, SMS and voice also need delivery configured under **Settings → Messaging** (SMTP, SendGrid, Amazon SES, Postmark or
Mailgun for email; Twilio or any HTTP API for SMS; Twilio or any HTTP API for voice). People add methods on their profile page.

Each channel can have several **ways** on at once. Each way is its own factor, so a policy can allow one and refuse another:

| Way | What the person does | Phishing resistant by default |
| --- | --- | --- |
| Code typed into the sign-in page | Types the code that was sent to them into the sign-in page. | No: a fake sign-in page can ask for it. |
| Number matching | Sends the number shown on the sign-in page back from the device that got the message: by opening the link (email, SMS), by pressing it on the keypad (call), or by replying to the message with it. | Yes |
| Yes or no, unverified | Answers Y or N to "are you logging in?" (on a call, 1 or 2). Nothing is shown on the sign-in page. | No |
| Yes or no, verified | Replies with the number shown on the sign-in page to approve, or N to deny. | Yes |

So there are two ways a number-matching sign-in is confirmed: the number is **typed into the device** (link or keypad), or the number is **sent back as a reply** from the device. Both use the same number, shown only on the sign-in page, and both work only against the sign-in that is waiting.

**Code and number length.** The same section sets the **code length** (digits in a typed code) and the **number length** (digits in the number for number matching). Each can be from 2 to 6. The number length defaults to 3 and the code length to 6. Short codes are easier to guess, so keep at least four unless a policy or a short window calls for less.

**Message wording.** Each way has a template under **Settings → Message templates**, per channel. Number matching and verified yes or no must tell the person to reply with, or enter, **the code shown on their sign-in screen**, and yes or no must say **Reply Y to approve or N to deny** (on a call, *press 1* and *press 2*). The editor refuses a template that leaves out that instruction, so a person is never sent a message that does not say what to do. The number itself is never in the message.

**Receiving replies.** Replies come back to the server through webhooks, and each provider's webhook is checked before anything is read. A reply is matched only to a sign-in that is waiting for an answer from that address or number, so a stray reply approves nothing. The webhook addresses are shown on **Settings → Messaging**:

- **Postmark:** the inbound webhook is `<BASE_URL>/messaging/inbound/postmark/<token>`, where the token is shown on the Messaging tab and is checked on every request.
- **Mailgun:** a route that forwards to `<BASE_URL>/messaging/inbound/mailgun`. Each request is signed with the HTTP signing key, and requests older than fifteen minutes are refused.
- **Amazon SES:** an SES receipt rule that publishes to an SNS topic, subscribed to `<BASE_URL>/messaging/inbound/ses`. SNS signatures are checked against AWS's certificate. Set the topic ARN to accept only that topic.
- **SMS (Twilio):** the incoming-message webhook of the sending number is `<BASE_URL>/messaging/inbound/twilio-sms`. Each request is checked with Twilio's signature and the account auth token.

`BASE_URL` must be reachable from the provider for replies and for voice calls. Voice answers use Twilio, which fetches the call's instructions from `/factors/voice/<token>`.

**Amazon SES** sends through the SES v2 API with an IAM access key (the request is signed with AWS Signature Version 4). **Postmark** sends with a server token and a message stream. **Mailgun** sends to your sending domain in the US or EU region with its private API key.

Which methods count as phishing resistant is the administrator's call: **Settings → Sign-in factors → Phishing-resistant methods** lists security keys, the authenticator app, and each way of each channel. By default security keys, number matching and verified yes or no are ticked. That list is what a policy's *require a phishing-resistant factor* and the risk rules' *phishing-resistant factors only* limit people to.

Policies can **limit the allowed factors** (by way, such as *email, yes or no, verified*, or by channel, which allows every way that is on) and **require phishing-resistant factors**. A person who has factors but none allowed
is refused rather than let in with less; an administrator removes their factors on the user page and they can then set up an
allowed one at their next sign-in (only a security key or authenticator app can be set up at that point, because email, SMS
and voice need a verified destination). Codes and links expire after five minutes, allow five (code) or three (number) tries,
and are never stored in readable form.

**Remembering a second factor.** A policy can set **Remember a second factor for (hours)**. After someone completes a second factor in a browser, that browser skips it on later password sign-ins for that long, counted from when the factor was completed (not from the last sign-in). Blank means no rule; 0 means always ask. When several policies apply, the shortest period wins. A remembered factor is never reused once it has been removed or stops being allowed, and it is not used while Duo is turned on, since Duo decides for itself each time. Only the built-in factors are remembered. A person can ask to be asked again at their next sign-in, from every browser, with **Require MFA at my next sign-in** on their profile (`POST /api/account/mfa/forget`). Remembered sign-ins are logged as `login.success` with `remembered: true`.

**Application policies.** **Settings → Application policies** (same permissions as Policies) sets what sign-in an application or SAML service provider needs before it gives someone a sign-in: a second factor, a phishing-resistant factor, or only certain factors (for example, security keys only for a payroll system). A policy names the applications it covers, and several policies can cover one application, with the strictest rule of each applying. When a signed-in person's sign-in does not meet the rule, they are asked for a second factor that does, and then sent back to the application. If they have no factor that meets it, they are refused with a message that says what is needed. The check runs when an authorization code is issued (OpenID Connect and OAuth 2.0), when a CAS ticket is issued, and when a SAML response is issued. Tokens already issued are not rechecked. Changes are audited as `app_policy.create/update/delete`; step-ups as `sso.app_policy`.

### Duo break-glass

If Duo is down, misconfigured or its keys have been revoked and MFA is enforced, nobody can finish a sign-in, including administrators. To get back in, create an empty file named `duo-disabled` in the database's directory on the server (`data/` by default, next to `idp.db`):

```sh
touch data/duo-disabled
```

While the file exists, Duo is off whatever the console or `config.json` says. Sign-in uses the built-in factors (authenticator app, security keys, email, SMS, voice) under the usual policies, and the Duo MFA tab under **External systems** shows a red notice. The server also prints a warning at startup. The saved Duo settings are kept, so the file only switches Duo off; it does not change its configuration. To turn Duo back on, fix the problem, then delete the file (`rm data/duo-disabled`). Duo is used again on the next sign-in, with no restart.

Some things to know before you rely on it:

- The file is checked on every sign-in, so it takes effect at once, and removing it takes effect at once too.
- Only someone who can write to the server's data directory can create it. It cannot be set from the web console, so an attacker with a console login cannot switch Duo off that way.
- Only the Duo step is skipped. The password, account lockouts, policies and the built-in factors still apply. A person who has no built-in factor set up is offered enrollment as usual, so set up an authenticator app or security key for administrators before Duo is ever needed.
- While the file is present, the server logs `settings.duo_bypass` at each start, and prints a warning. Remove the file as soon as Duo is healthy again: while it stays, Duo is not checked at all.

## RADIUS

Pons Identity can act as a **RADIUS identity server** (RFC 2865) for VPN gateways, switches, wireless controllers and SSH hosts. Turn it on under **External systems → RADIUS** (needs *Configure RADIUS*, `radius.manage`). It listens on UDP port 1812 by default (`docker-compose.yml` publishes it; open it in your firewall for the listed devices only).

- **Clients.** A device is answered only if it is listed, by address or range (`10.0.0.5`, `10.0.0.0/24`, IPv6 too; the most specific range wins), with its own shared secret (at least 12 characters, stored in the settings table like the Duo secret key and never sent back to the console). Anything else, and any request with a wrong signature, is ignored silently, as the RFC says.
- **Signed requests.** By default a client must sign its requests with a Message-Authenticator (RFC 3579), which is the defence against the 2024 "BlastRADIUS" forgery attack. Turn this off per client only for a device that cannot send one.
- **PAP only.** The device sends the password encrypted with the shared secret. Only one-way password hashes are stored here, so methods that need the plain or NT-hashed password (CHAP, MS-CHAPv2, EAP) are refused.
- **Same rules as the sign-in page.** Disabled accounts, blocking policies, directory (LDAP) passwords, and required or permitted factors are all applied, and after 10 failures in 5 minutes a name is locked for a while. Risk-based rules are not applied, since the address seen is the device's, not the person's.
- **Second step.** A person with an authenticator app is asked for the code with an *Access-Challenge* (the device shows our prompt and sends the code back with our `State`; a challenge is good for 90 seconds and one try), or, per client, types the code straight after the password (`secret123456`). Other factors need a web page and cannot be used over RADIUS; someone whose only factors are those is rejected, as is someone who must use a second factor but has none.
- **Who may use a client.** Optionally limit a client to members of some groups (nested groups count).
- **Attributes sent back.** Per client: `Filter-Id`, `Class`, `Reply-Message`, `Session-Timeout`, `Idle-Timeout`, `Service-Type` and `VLAN` (sent as `Tunnel-Type=VLAN`, `Tunnel-Medium-Type=IEEE-802` and `Tunnel-Private-Group-Id`), each for everyone or only for members of a group.
- **Records.** Every accept and reject is in the **Sign-in log** and the audit log (`login.success` / `login.failure` with `via: "radius"` and the client's name; unknown devices as `radius.unknown_client`, bad signatures as `radius.bad_request`). Changes to settings are `settings.radius`, which lists clients but never their secrets.

Accounting (port 1813) is not implemented.

## User API

Other software can create and manage ordinary local users through a REST API at `/api/v1`: create, look up, change and delete
users, import up to 1000 at once, and schedule account creation, activation, deactivation and deletion. Create a token in
**API → User API** (shown once, stored hashed), choose its scopes (`users:read`, `users:write`, `bulk:write`,
`schedules:write`) and optionally an expiry.

```
curl -X POST https://idp.example.net/api/v1/users \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"username":"srivera","generate_password":true,"emails":[{"email":"srivera@example.net","primary":true}]}'
```

A token cannot change administrators (anyone holding a role) or users owned by an external directory, and cannot grant roles.

The API is described by an OpenAPI 3.1 file, [docs/openapi.yaml](docs/openapi.yaml), served at `/api/v1/openapi.yaml`. A rendered
reference page is built with Redocly and served at `/api/v1/docs`:

| Command | Does |
| --- | --- |
| `npm run docs:lint` | Checks the description against the rules in `redocly.yaml` |
| `npm run docs:build` | Writes the self-contained page `docs/api.html` (the Docker image does this for you) |

A test keeps the description and the routes in step: adding an endpoint without documenting it fails `npm test`.

## Integrations

**Integrations** (its own page in the console, not under Settings) holds scripts that process data from, or send data to, other systems: create users from an HR feed, look people up in an outside service, post to a chat channel. Needs `integrations.view` to see and `integrations.manage` to change or run. Treat `integrations.manage` as a powerful permission: a script acts with whatever scopes it was given.

A script is JavaScript that runs as the body of an `async` function, so `await` works anywhere and `return` stores a run result. Four ways to start one:

- **Console**: **Run now**, with JSON input.
- **Webhook**: `POST /hooks/integrations/<id>` with `Authorization: Bearer iwh_…` and a JSON body, which arrives as `input`. The response is `{ status, result, logs, error }`. Only a hash of the token is stored.
- **Schedule**: every 5 to 10080 minutes, daily, or weekly, always in UTC. `input` is `{ scheduled_for }`. A run still going when the next is due is not started twice, and a server that was off runs a missed schedule once on start.
- **Event**: when a user is created, changed or deleted, has a password reset, a group gains or loses a member, or someone signs in or fails to. Events are read from the audit log, so changes from the console, the user API, imports and other scripts all count; changes made by a script are never delivered, so integrations cannot start each other in a loop. `input` is an event object with `actor`, `target`, `detail` and, where it applies, `user`, `group` and `member`.

Scheduled and event runs go through one queue and run one at a time (up to 100 waiting). Turning an integration off stops its webhook, schedule and events.

**Scopes** limit what a script may touch, per integration: `users:read`, `users:write`, `groups:read`, `groups:write`, `directory:read`, `directory:write`, `http`, `messaging`, `files` and `sftp`. As with the user API, a script can change only ordinary local accounts: never an administrator, never a user an external directory owns, it cannot grant roles, and it can change only local groups.

**Integrations** have an **Inputs** table as well, above the script: each row names a key of the data the integration is started with (`input`), and the variable the script reads that value from. The name column offers every input the server supplies, alphabetically (the Reference lists them), and accepts any other name. The rows are checked on save. `input` stays available as the whole object.

**Variables** (Integrations → Variables) are read as `vars.NAME` or `vars.get("NAME", fallback)`. A variable can be a **secret**: its value is never shown again and is replaced with `[secret]` in run logs, results and errors. **Pre-made, read-only variables** are `idp.baseUrl`, `idp.appName`, `idp.userFields`, `idp.attributes`, `idp.channels`, `input`, `trigger` and `integration`.

**Functions** (Integrations → Functions) are JavaScript an administrator writes once, and any integration calls as `await fn.NAME({ ... })`. A function has an **Inputs** table: one row for each key of the object the caller passes, and the variable the code reads that value from. Rows can be added and removed, and the name column works the same way. It returns one value. It runs inside the calling integration's run, so it has that integration's scopes, variables and limits and cannot do more than its caller. Reports cannot call functions. Starter functions are added when the database is first created (`normalizeEmail`, `splitName`, `toE164`, `parseBoolean`, `dateInDays`, `chunk`, `uniqueBy`, `requestJson`, `findOrCreateUser`, `addToGroups`); edit or delete them as you like, and a deleted starter stays deleted.

**Pre-made functions**: `idp.identity.start / status / latest` (scope `identity`, see [Identity verification](#identity-verification)), `idp.users.find / search / create / update / delete / suggestUsername`, `idp.groups.list / members / addMember / removeMember`, (a group can be named by its name or by the ID number shown on its page and in the Groups list), `http.get / post / request`, `mail.send`, `sms.send`, `csv.parse`, `util.randomPassword / uuid / sha256 / hmacSha256 / base64Encode / base64Decode`, `sleep` and `log`. The console's **Reference** tab documents everything an author needs: every object field by field with an example (`User`, `NewUser`, `UserPatch`, `Group`, `HttpResponse`, `Event`, and more, including the attributes you have defined), every event with its input, each function with what it returns, how it fails and an example, and the limits. It is generated by the server, so it is always what is really available. Every variable, function and attribute has an example value, and the **Recipes** section holds complete scripts for common tasks: creating or updating accounts from an HR export, turning off an account when someone leaves (from a webhook), posting a welcome message on `user.created`, exporting a group to SFTP, warning about expiring badges, and calling an HR API with a secret key. Copy one into a new integration and change the names to match your systems. The **Attributes** section lists the attributes you defined, with the type and an example value of each, and shows how a script reads and writes them.

```js
// Create the person in an HR record unless they already exist, and email them a first password.
const existing = await idp.users.find({ employee_id: input.employee_id });
if (existing) return { skipped: existing.username };
const user = await idp.users.create({
  username: await idp.users.suggestUsername(input.first, input.last),
  first_name: input.first, last_name: input.last, email: input.email,
  employee_id: input.employee_id, groups: ['Staff'], generate_password: true,
});
await mail.send({ to: input.email, subject: 'Your account', text: `Password: ${user.generated_password}` });
return { created: user.username };
```

**How scripts are run.** Each run happens in its own worker thread with an empty environment, a memory ceiling and a time limit (1–60 seconds, default 10) after which the thread is stopped. The script has no `require`, `process`, `fetch`, file or database access and cannot `eval`; the functions above are its whole reach, and calls are capped per run (2000 calls, 50 web requests, 25 messages). `http` uses the same rules as other outbound calls here: public addresses only, no redirects (`ALLOW_PRIVATE_FETCH=true` allows internal hosts). This contains mistakes and runaway loops; it is not a defence against a hostile administrator, so give `integrations.manage` only to people you trust with the scopes you grant.

**Who can run what.** People who manage integrations can run any of them. Under **Who can run it**, an integration can also be opened to chosen groups; their members (nested groups count) get **Run an integration** in the top bar and can run only those, with the integration's own scopes, without being able to read or edit it. They are audited as `integration.run_by_group`.

**External directories.** A script can read and manage people in an LDAP or Active Directory server that is set up under **External systems → Directories**. Two things must allow it: the directory's **Script access** (*Not available to scripts* by default, *Read only*, or *Read and write*, which needs a service account) and the integration's scopes `directory:read` (look people up) and `directory:write` (create, change and delete). Either one being missing keeps a script read-only or out. A script connects, works through the connection, and closes it:

```js
const dir = await directory.connect("Corporate AD");
try {
  const sam = await dir.find({ email: "sam@example.net" });          // also { username }, { dn }, any mapped field
  if (!sam) await dir.create({ username: "srivera", first_name: "Sam", last_name: "Rivera", email: "sam@example.net",
                               password: await util.randomPassword(20), parentDn: "OU=Staff,DC=example,DC=net" });
  else await dir.update(sam.username, { department: "Sailing" });
  const old = await dir.search({ filter: "(department=Retired)", limit: 50 });
  for (const p of old) await dir.delete({ dn: p.dn });
} finally {
  await dir.close();
}
// or let directory.use close it for you, even if the function throws:
const names = await directory.use("Corporate AD", async (d) => (await d.search({ q: "rivera" })).map((p) => p.username));
```

Profile fields are read and written through the directory's attribute mapping; `attributes` reaches any other LDAP attribute. A script only sees and changes *people* (entries the directory's user filter matches) inside the directory's search base, cannot change a username, cannot read or set password attributes except through `password`, and cannot change or delete the service account it is bound as. `active` (disable or enable an account) and Active Directory's password format are handled for Active Directory directories. Creating an Active Directory account removes it again if its password cannot be set. Group membership is read, not written.

**Connections never outlive the run.** A run may hold 3 connections and make 200 directory calls. Whatever a script leaves open is closed when the run ends, however it ends: finished, failed, stopped by the time limit, or the worker dying. A connection unused for 30 seconds is closed, none lives longer than 5 minutes, and the server closes all of them when it is asked to stop (if the server process is killed outright, the operating system closes the sockets and the directory ends the sessions). Using a connection after it has closed fails with a message to connect again. Connecting and every create, change and delete are audited (`directory.script_connect`, `directory.script_user_create/update/delete`, with the DN and field names, never values).

**Files and SFTP.** Scripts reach the files module with `files.write/read/list/exists/mkdir/delete` (scope `files`). A relative path is in the integration's own folder, `/integrations/integration-<id>`. An absolute path such as `/exports/hr/people.csv` is allowed only inside a directory listed under the integration's **Directories it may use**, each for read, write, or read and write; nothing else in the files module is reachable. `sftp.list/get/put/delete/download/upload` (scope `sftp`, needs the `ssh2` package) exchange files with another server: public addresses only, the server's key must match a `hostFingerprint` the script gives (or the script says `insecureSkipHostCheck: true`), credentials belong in secret variables, and 20 operations run per run. `sftp.download` and `sftp.upload` move a file between the other server and the files module without it passing through the script. Every SFTP operation is audited as `integration.sftp`. The module, its grants and the SFTP server that other software uses are described in [Files and SFTP access](#files-and-sftp-access).

**REST API.** Turn on *Allow API requests to run this* and give a User API token the `integrations:run` scope: `GET /api/v1/integrations`, `POST /api/v1/integrations/{id}/runs` with `{ "input": … }` (answers `201` with the run, whatever its status) and `GET /api/v1/integrations/{id}/runs/{runId}`. See the API reference.

**Built-in integrations.** The first start after they were added creates *Password reset* (new random password emailed to the person), *Deactivate a user*, *Import users from a CSV file* and *Export users to a CSV file*. They can be edited, turned off or deleted, and are not created again. None can be run by anyone but integration managers until a group is allowed on it.

**Per-integration logging.** An integration can keep its own logging settings (the lowest level to save, whether to save output, and how many days its saved log files are kept) instead of the global ones. Its saved files age out by those settings.

**Output and logging.** Two things are written, and they are kept apart. `output(...)` prints what the run produced, like `console.log`: it is shown in the **Output** section of the run's page and kept with the run history. `log()`, `log.debug()`, `log.warning()` and `log.error()` write to the **Log** section of the page at the levels debug, normal, warning and error (`console.debug/log/info/warn/error` map onto the same four). Lines at or above the level chosen under **Integrations → Logging** are also saved to the files module, as one plain text file a day under `/logs/integration-<id>/`, and kept for the number of days set there. `output()` lines are saved only when **Also save output** is on. Every line has a color: a default per level and for output (grey for debug, orange for warning, red for error), or one the script picks for that line with `output.color(green, done)` or `log.error.color(#b3261e, …)` (a name, or a hex value).

**The run's page.** A run started from the console (**Run now**) opens in a new tab as it starts. The page is plain text on a white background, like a log file: the integration's name and run number, the node it ran on, the lines the script logged and printed in the order they happened (in the colors the script chose), how the run ended and its result, and last, when it started and ended and how long it took. It fills in as the run goes and keeps checking until the run has ended. Reloading the page runs the integration again with the input of the run it shows, and the page moves to that new run; opening a run without reloading only shows it. A run whose input had a secret-looking value, or was too long to keep, cannot be run again from its page, and the page says why. Every run is recorded as `running` before it starts, so a server that stopped during a run marks it as an error when it starts again. The last 50 runs of each integration are kept, with input, logs, output, result and node. Fields named like a password, secret or token in a stored result or input are replaced with `[redacted]`. Everything a script changes is audited with the actor `integration:<name>`; changes to an integration are audited without its script text, and variable changes without values.

**Version control with Git.** The **Git** button on the Integrations page opens a dialog that commits the integrations' settings and code to a repository the server keeps in `data/integrations-git/`, and pushes it to a remote. Each integration is `integrations/<name>/integration.json` (scopes, inputs, schedules, events, limits, who may run it) plus `script.js`; each function is `functions/<name>/function.json` plus `function.js`; `variables.json` lists variables (secret values are never written, nor are webhook tokens or run history). The files are generated from the database, so editing the repository does not change Pons Identity.

- The dialog says whether there is a repository yet (*committing will initialize one*), what changed since the last commit and what is not pushed. **Commit all changes** needs a message; the commit is authored by the signed-in administrator.
- **Push** takes an https remote URL, a branch and an access token with write access. The token is used for that push only: it is not stored, logged, written into the repository or put on a command line (it reaches `git` through its environment). Pushes are never forced; if the remote has newer commits, merge them there first.
- Remotes must be public https addresses with no credentials in the URL (`ALLOW_PRIVATE_FETCH=true` allows an internal Git server). Git runs with no shell, no hooks, no system or user configuration and only the https transport. The server needs the `git` program (the Docker image includes it).
- Seeing the state needs `integrations.view`; committing and pushing need `integrations.manage`, and are audited (`integration.git.commit`, `integration.git.push`).

## Files and SFTP access

The **files module** keeps the files integrations write and read, and the files other software exchanges with them. It is one store of files and folders, browsed under **Integrations → Files**. A file can be at most 10 MB, and the module keeps at most 20,000 files and 1 GB in all. A file whose name looks like plain text (`.txt`, `.csv`, `.log`, `.json`, `.md`, `.xml`, `.yaml` and similar) and is at most 256 KB has a **View** button that shows its text; the server also checks that the contents are plain text, and anything else is only downloadable.

| Path | What is there | Who can reach it |
| --- | --- | --- |
| `/integrations/integration-<id>/` | An integration's own files. A relative path in its script is here. | That integration, with the `files` scope |
| Any other directory, such as `/exports/hr` | Files an administrator or an integration keeps there | Integrations granted it under **Directories it may use**, and service accounts granted it |
| `/logs/integration-<id>/` | Saved log lines, one `YYYY-MM-DD.log` file a day | Read in the Files tab, or over SFTP by a service account granted `/logs` |

**Grants.** A grant is a directory and an access. `read` lists and reads what is under it. `write` creates, changes and removes, but cannot read (a drop box for a partner). `readwrite` does both. Folders above a grant show only the way down to it, so a service account sees its own directories and nothing else. An integration's grants are its own folder plus the directories listed on the integration; a service account's are the directories given to it.

**Service accounts** (**Users → Service accounts**) are for other software, not people. Each has a name, a password (at least 12 characters, or one generated and shown once), or SSH public keys, or both, and its grants. A service account cannot sign in to the console, and its name does not clash with a person's. Turning one off, or changing its grants, takes effect on its next request. Creating, changing, resetting the password of, and deleting a service account are audited as `service_account.*`.

**Locking down a service account.** If an account's password or keys may have leaked, open **Users → Service accounts** and select **Lock down**. The account is turned off, its password is replaced with one nobody knows, its SSH keys are suspended, and its open SFTP connections are closed at once. The row shows **In lockdown** while it lasts, and an edit cannot turn the account back on or give it keys. **End lockdown** turns it on again only if it was on before, and it restores the suspended keys only if you tick the box; the password is never restored, so set a new one. Lock and unlock are audited as `service_account.lockdown` and `service_account.lockdown_end`.

**The SFTP server** is turned on under **Integrations → Files**: choose the port (2222 by default) and the address to listen on, and save. It creates its host key the first time it starts, and the page shows the key's fingerprint for software to check the first time it connects. It is off until it is turned on. Other software connects as a service account, with its password or key:

```sh
sftp -P 2222 hr-export@idp.example.net
sftp> ls /exports/hr
sftp> get /exports/hr/people.csv
sftp> put people.csv /incoming/
```

The top level of a session lists only the directories the account is granted. Over SFTP an account can list, read, write (a file is saved when it is closed), create and remove files and folders, and rename them. Setting permissions or times is accepted and ignored. Every sign-in, successful or not, is audited as `service_account.sftp_login`, and each file written, removed, renamed or made is audited as `service_account.file`. Publish the port only to the network the software is on (the example `docker-compose.yml` shows how), and prefer keys for software that runs unattended.

**Saved logs.** Saved log lines are plain text, one file a day for each integration, with one line per entry: the time (UTC), the run number, the stream (`log` or `output`), the level, the color (empty for the default) and the text. Tabs, new lines and backslashes in the text are escaped, so one line of the file is one line printed. Retention removes a file once its date is older than the number of days in the integration's logging settings (its own, or the global ones); set the days to 0 to keep them until someone deletes them. A file can be downloaded in the Files tab, read over SFTP by a service account granted `/logs`, or deleted from **Integrations → Logging**.

**Upgrading.** The first start after this version moves what was kept before: each integration's files go into its own folder (`/integrations/integration-<id>/`), and saved log lines are written to the daily files under `/logs`. Nothing is lost, and the tables they were kept in are removed.

## Reports

**Reports** (its own page in the console) shows data from the IdP as a table that can be downloaded as CSV. Two permissions control it: `reports.view` runs reports, and `reports.manage` (which includes `reports.view`) writes, edits and deletes them.

**Pre-built reports**: active users without MFA, deactivated users, old passwords (`input.days`), users by department, group sizes, failed sign-ins by user (`input.days`) and administrative changes (`input.days`). They are ordinary report scripts, so opening one shows its code, and **Copy to a new report** turns it into a starting point for your own.

**Report builder.** **Build a report** (on the Reports page) makes a report without code. Choose a data source (users, groups, sign-ins or the audit log), the accounts or days it covers, and filters (*only the rows where*). Then show either **the rows**, with the columns you pick, or **a summary**: group by a field (by day or month for dates) and work out counts, distinct values, sums, averages, minimums or maximums for each group. The summary can be a table, a bar, line or pie chart. **Preview** runs it without saving; the result lists its rows and the chart with the figures underneath. A builder report reads the same data as a script, through the same functions, so it shows the person running it only what they may see, and the source's permission is checked when it runs. Builder reports are edited in the builder; they keep no script.

**Custom reports** are JavaScript, run as the body of an `async` function, in the same sandbox as integration scripts (own worker thread, memory ceiling, time limit of 1–60 seconds, default 20, no `require`, `process`, `fetch` or `eval`). `return` an array of objects to get a table; anything else is shown as JSON. The person running a report may type JSON that arrives as `input`.

| Function | Needs | Returns |
| --- | --- | --- |
| `report.users({ active, limit })` | `users.view` | Every user (local and directory) with groups, attributes, MFA requirement, password and creation times. `last_sign_in` is filled in only if the runner also holds `audit.view`. |
| `report.groups()` | `groups.view` | Each group with its member count, nested members included. |
| `report.signIns({ days, type, outcome, username, country, ip, limit })` | `audit.view` | The sign-in log, newest first (default 7 days and 1000 rows; at most 365 days and 5000 rows). |
| `report.audit({ days, category, action, outcome, actor, limit })` | `audit.view` | The audit log, same defaults and limits. |

`log()`, `input`, `csv.parse` and `util.*` also work. Reports are **read-only and run with the access of whoever runs them**, not whoever wrote them: each `report.*` function checks the runner's permissions, so granting `reports.manage` does not let anyone see data they could not already see, and a report written by an administrator shows less when a less privileged person runs it. They have no scopes, so `idp.users.*`, `idp.groups.*`, `http`, `mail` and `sms` are refused, and they cannot read integration variables, including secrets. A result can be up to 4 MB (integrations: 256 KB) and is returned to the person who ran it and not stored. Running a report is audited (`report.run`: its name, outcome and duration, never its rows), as are creating, changing (without the script text) and deleting one.

Downloaded CSV prefixes cells that start with `=`, `+`, `-` or `@` with an apostrophe so a spreadsheet does not run user-controlled text as a formula.

## External directories (LDAP / Active Directory and REST)

**External systems → Directories** (needs the *Configure external directories* permission) connects external directories. One directory can do either or both of the following.

**Federated sign-in.** Give it an `ldaps://` URL (or `ldap://` with StartTLS; plain `ldap://` is refused because passwords would travel unencrypted), a search base, and a user filter containing `{username}` (the typed name is escaped, so it cannot alter the filter). Sign-in then works like this:

1. Pons Identity binds as the optional service account, finds exactly one matching entry, and binds again as that entry with the password the user typed. The password is never stored. An empty password is refused outright, because many servers treat it as an anonymous bind.
2. On first sign-in the account is created (unless *Create accounts at first sign-in* is off). At every later sign-in the attributes in the *Attribute mapping* table, and the groups in the membership attribute (e.g. `memberOf`), are refreshed. Directory groups are read-only in the console; a directory group whose name matches a local group is skipped.
3. TOTP and Duo still apply after the directory password.

Accounts that already exist locally (including `admin`) are never taken over: a directory only signs in users it owns. If the directory is unreachable sign-in fails closed with a 503, and disabling a directory stops its users signing in. Roles are never granted by a directory. *Test connection* checks the saved settings and previews what would be read for a username. The service account password is kept in the database, like the Duo secret key, and is never sent back to the console.

**REST API for updating identities.** Create a token on the directory (shown once; only a hash is stored) and enable the directory. The external system then calls `https://<idp>/directory/v1` with `Authorization: Bearer <token>`. A token reaches only the users its own directory owns (anything else is a 404), and cannot set roles.

| request | effect |
|---|---|
| `GET /users?username=&external_id=&email=&limit=&offset=` | list (limit up to 200) |
| `GET /users/:id` | read one; `:id` is the user's GUID |
| `POST /users` | create; `201` with `Location` (`409` if the username or `external_id` is taken) |
| `PUT /users/:id` | replace the profile; fields left out are cleared |
| `PATCH /users/:id` | change only the fields sent |
| `DELETE /users/:id` | delete (`204`) |

A user is a JSON object with `username` (required), `external_id`, `active` (boolean), the profile fields (`first_name`, `last_name`, `display_name`, `email`, `employee_id`, `department`, `title`, `phone`, `upn`, `sam_account_name`, `distinguished_name`, `mail_nickname`, `company`, `manager`, `office`, `mobile`, `street_address`, `city`, `state`, `postal_code`, `country`, `description`), `attributes` (an object of custom string attributes), `groups` (an array of group names that replaces this directory's memberships for the user; PUT and PATCH leave `attributes` and `groups` alone when they are not sent) and `password`. A password is accepted only from a directory with no LDAP URL, which then holds the credentials itself; otherwise sign-in is delegated to LDAP. Errors are `{ "error": "...", "errors": ["..."] }`.

    curl -X POST https://idp.example.com/directory/v1/users \
      -H "Authorization: Bearer dpt_..." -H "Content-Type: application/json" \
      -d '{"username":"jordan","email":"jordan@example.com","external_id":"E-100","groups":["HR staff"]}'

Deleting a directory removes its groups; its users stay as ordinary accounts (with no password until an administrator sets one).

### Provisioning from an HR, ERP or payroll system

A directory can also be fed by a system of record. This is independent of any product: Workday, Oracle HCM, PeopleSoft, Banner, a payroll export or a spreadsheet all work, because the only requirement is a list of people as CSV or JSON. Open the directory in **External systems → Directories** and use **Provisioning feed** (same permission as the rest of the directory). The directory can also have an LDAP server for passwords; the feed then supplies who exists and the directory supplies how they sign in.

**Delivering the list.** Any of these, using the same settings:

| Way | How |
|---|---|
| Push | The source system calls `POST /directory/v1/feed` with the directory's token and `Content-Type: text/csv` or `application/json` (up to 25 MB, 50,000 records). `?mode=full\|delta` overrides the setting; `?dry_run=true` only reports. Needs the feed switched on. |
| Fetch | Pons Identity downloads a public https address on a schedule (every 5 minutes or more), sending an optional header such as `Authorization: Bearer ...`. The header value is stored but never shown again. |
| Upload | Choose a file on the page (up to about 1 MB) and preview or apply it. |

**Full or delta.** A *full* list names everyone who should exist, so anyone the directory owns who is missing has left. A *delta* list carries changes only, and absence means nothing; leavers are then signalled by an inactive status or an end date.

**Mapping.** A rule per line, `target = expression`, in the same expression language as SAML attribute transformations (`lower upper trim concat replace extract split substring coalesce join first attr drop`). A bare name is a CSV column or JSON field (`name.first` reaches into nested JSON); use `attr("Column Name")` when it has spaces. A target set earlier can be used later. Example:

```
external_id = attr("Employee ID")
first_name  = attr("Legal First Name")
last_name   = attr("Legal Last Name")
username    = lower(concat(first_name, ".", last_name))
email       = lower(attr("Work Email"))
department  = attr("Department")
active      = extract(attr("Worker Status"), "^(Active|Leave)$")
start_date  = attr("Hire Date")
end_date    = attr("Termination Date")
groups      = concat("dept-", lower(department))
groups      = "Employees"
groups      = extract(attr("Worker Type"), "^(Contractor)$")
custom:badge_number = attr("Badge")
```

| Target | Meaning |
|---|---|
| `external_id` (required) | The source system's permanent identifier. It joins a record to an account, so it must not change or repeat. |
| `username` (required) | Used when the account is created. An existing account keeps its username. If the name is taken by any other account, that record is reported as an error, or with *Add a number* becomes `sam.rivera2`. |
| any profile field | `first_name`, `last_name`, `display_name`, `email`, `employee_id`, `department`, `title`, `phone`, and the other fields listed above. Only the fields you map are changed; a mapped field that comes out empty is cleared. |
| `active` | `true`, `yes`, `1`, `active`, `enabled` mean active; `false`, `no`, `0`, `inactive`, `terminated`, `disabled` mean inactive; anything else is an error. If you map `active`, a record that yields no value is inactive, which is what makes the `extract(..., "^Active$")` idiom work. Unmapped means active. |
| `start_date` | ISO 8601 (`2026-09-01` or `2026-09-01T09:00:00-05:00`). The account is created inactive and switched on when the date arrives. A date alone starts at 00:00 UTC. |
| `end_date` | ISO 8601. The account is switched off after it; a date alone lasts through the end of that day (UTC). |
| `groups` | Group names. Several `groups` rules add up, and a rule that yields nothing adds nothing, so `extract` can make a group apply to some people only. Groups are created as needed, belong to the directory, and are read-only in the console. A name already used by a local or other directory's group is skipped with a warning. |
| `custom:<name>` | A custom user attribute. Custom attributes the feed does not map are left alone. |

**Joining and ownership.** Records match accounts by `external_id` within the directory. The feed never takes over an account it did not create: it cannot touch local accounts, other directories' users or roles, and it cannot set passwords. Sign-in for fed accounts is therefore through the directory's LDAP server or federation, or a password an administrator sets.

**Leaving.** For people missing from a full list, *Missing from a full list* chooses between deactivating (sessions end immediately) and leaving the account alone. *Delete after* removes an account that has stayed deactivated by the feed (missing, inactive or past its end date) for that many days; 0 never deletes. Someone who reappears, or whose status or end date changes back, is reactivated. The feed acts only on changes in what the source says: if an administrator reactivates or deactivates an account by hand, the next unchanged delivery does not reverse it. A feed never deactivates the last active administrator and never deletes anyone who holds a role. Dates take effect on time without a delivery: a job checks every ten minutes.

**Safety.** A delivery is held back, changing nothing, when a full list is empty, when more than *Hold back above* percent of managed people would be deactivated (default 20%; 100 turns this off), or when more than half the records cannot be processed (usually a wrong mapping). A held push gets `409`; use **Apply anyway** on the page, with an upload or fetch, to approve it. Every run, applied, held back or failed, is kept in the page's history (50 per directory) with the records that changed, and **Preview** shows what a file or fetch would do without writing anything. Bad records are reported by row and do not stop the others; the whole delivery is applied in one transaction.

Audit events: `provisioning.run` (counts, never record contents), `provisioning.user_create`, `provisioning.user_deactivate`, `provisioning.user_reactivate`, `provisioning.user_delete`, `provisioning.user_skipped`, `directory.feed_update`.

Settings live in `config.json` (override the path with `CONFIG_FILE`):

| key | meaning |
|---|---|
| `protocol`, `hostname`, `port` | public address; the base URL in all metadata/entity IDs is built from these |
| `bindAddress` | interface to listen on (`127.0.0.1` for local only) |
| `baseUrl` | optional full override, e.g. `https://idp.example.com` when behind a proxy |
| `tls` | serve HTTPS directly (default: true when `protocol` is `https`). Set `false` if a reverse proxy terminates TLS |
| `tlsCertFile`, `tlsKeyFile` | PEM certificate (include intermediates) and key. If empty, a self-signed certificate for `hostname` is generated in `data/tls/` on first start |
| `httpRedirectPort` | if set (e.g. 80), also listen on this port and redirect HTTP to HTTPS |
| `dbPath` | SQLite file |
| `adminPassword` | password for the first-run `admin` account (random if empty) |
| `sessionSecret` | cookie secret (auto-generated and stored in the DB if empty) |
| `trustProxy` | set true behind a reverse proxy |
| `duoApiHost`, `duoIntegrationKey`, `duoSecretKey` | optional Duo MFA via the [Duo Auth API](https://duo.com/docs/authapi) (`DUO_API_HOST`, `DUO_IKEY`, `DUO_SKEY`). Enabled when all three are set. After the password, Duo decides per user: `auth` requires a Duo Push or passcode (replacing the TOTP step for that sign-in), `deny` blocks sign-in, `allow` and `enroll` fall back to the TOTP rules. If Duo is unreachable, sign-in fails closed. A file named `duo-disabled` next to the database turns Duo off in an emergency (see [Duo break-glass](#duo-break-glass)) |
| `auditRetentionDays` | days to keep audit events; older ones are pruned at startup and daily. `0` keeps everything. Default `365` (`AUDIT_RETENTION_DAYS`) |
| `auditStdout` | print each audit event as a JSON line to stdout, for container log shippers. Syslog and SIEM destinations are configured in **Settings › Log forwarding**, see [Audit log](#audit-log) |
Environment variables override the file: `PORT`, `BIND_ADDRESS`, `BASE_URL`, `DB_PATH`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `TRUST_PROXY`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `SETUP_WIZARD`, `HTTP_REDIRECT_PORT`, `AUDIT_RETENTION_DAYS`, `AUDIT_STDOUT`.

Use a certificate your SPs and browsers trust in production (the auto-generated one is self-signed, so SPs that fetch metadata over HTTPS will reject it). The TLS certificate is separate from the per-SP SAML signing certificates. Changing the base URL changes every SP's entity ID/metadata, so set it before onboarding SPs.

## Identity federation (InCommon)

**Admin > Federation** has four tabs: **Federation settings**, **Signing and encryption**, **Attribute release** and **Other institutions**. The first three share one save button, so changes on one tab are kept while you move to another until you save.

1. **Metadata sources.** A source is signed metadata, trusted only if it verifies against the certificate you upload for it. Get
   that certificate from the federation's own site and check its fingerprint first. There are two kinds:
   - **MDQ service** (*Add InCommon MDQ*): the federation's per-entity query service. When a service provider sends a sign-in
     request, or a person picks an institution, that one entity is requested (`<base>/entities/<URL-encoded entity ID>`),
     verified, and cached for its `cacheDuration` (default 1 hour, at most a day, never beyond its `validUntil`). If the
     service is down when the cache expires, the old copy keeps being used until its `validUntil`. Unknown entities and failures
     are remembered for a short while, concurrent requests share one lookup, and at most 60 queries go out per minute, because
     entity IDs in sign-in requests come from outside. Nothing is stored for entities nobody asks about.
   - **Metadata file** (*Add InCommon IdP list*, or *Add source*): downloaded on a schedule, verified, and swapped in as a whole.
     *Keep* limits what is stored (everything, identity providers only, or service providers only). A failed refresh keeps the
     previous data. Fetches refuse internal addresses (`ALLOW_PRIVATE_FETCH=true` to allow them).

   For a large federation, use **both**: the identity-provider list (small, and it feeds the institution picker, which MDQ
   cannot list) and the MDQ service (so the many service providers are fetched only as they appear). The MDQ service and the
   downloadable files may be signed with different certificates; pin each source's own. The preset addresses are
   `https://mdq.incommon.org` and `https://md.incommon.org/InCommon/InCommon-metadata-idp-only.xml`; confirm both, and the
   signing certificates and fingerprints (published at https://ops.incommon.org/inc_md_cert.html), against InCommon's current
   documentation before relying on them. *Test lookup* on an MDQ source proves the address and certificate work.
2. **Federation identity.** One entity ID and one set of signing/encryption keys for all federation service providers
   (applications registered by hand keep their own identities). Set the scope, organization and contacts, enable it, then
   submit `/fed/idp/metadata` to the federation's registration tool. `/fed/idp/metadata?signed=true` is a signed copy with an expiry.
   Endpoints: `/fed/idp/sso`, `/fed/idp/slo`, and `/fed/idp/init?providerId=<SP entity ID>` for IdP-initiated sign-in.
3. **Attribute release.** A federation SP gets nothing unless a category it belongs to is switched on (R&S, REFEDS
   Pseudonymous/Personalized/Anonymous, Code of Conduct) or it marks an attribute as required. *Preview attribute release*
   shows exactly what a person would be sent. Check the category bundles in `src/federation/release-policy.js` against the
   current REFEDS/InCommon specifications before going to production.

If a service provider registered by hand has the same entity ID as a federation SP, its own attribute mapping, rules and
access settings are used, with the federation's issuer, keys and endpoints.

### Signing in people from other institutions

The same tab can also make this server a service provider in the federation. Enable *Sign in from other institutions*,
register `/fed/sp/metadata` with the federation as a service provider, and a *Sign in with your institution* button
appears on the sign-in page. People pick their institution (from the imported metadata, optionally limited by an allow list),
sign in there, and return to `/fed/sp/acs`.

- **Validation.** A response is accepted only if it replies to a request this session started, is signed (response or
  assertion) by a key in the institution's own published metadata, is unexpired, is addressed to this service provider's
  entity ID and ACS, and has not been used before. Encrypted assertions are decrypted with this service provider's key;
  RSA 1.5 key transport is refused. Only the signed content is read.
- **Accounts.** People are keyed on an identifier the institution is authoritative for: `pairwise-id`, `subject-id`, a
  persistent ID, or an `eduPersonPrincipalName` whose domain is a scope in the institution's metadata. They are **never**
  matched to a local account by email address, because any institution could claim any address. By default a first-time
  sign-in waits in a queue (*People from other institutions*) until an administrator approves it, which creates an
  account with no usable password, or links it to an existing user (needs *Manage users*). *Create an account automatically*
  is available; combine it with an allow list.
- **Policies.** A policy that blocks sign-in blocks this route too. A policy that requires multi-factor sign-in is met only
  if the institution reports the REFEDS MFA profile (`https://refeds.org/profile/mfa`).
- **Cookies.** The institution posts back cross-site, so the session cookie must be `SameSite=None`, which this app
  only sets over HTTPS. Plain-HTTP development setups cannot complete this flow.

### Registering with InCommon

1. Run the server on its final public https name and set `BASE_URL` to it. Entity IDs and endpoints are built from it, and
   changing it later means re-registering.
2. **Federation → Federation settings → Metadata sources → Add InCommon MDQ** and **Add InCommon IdP list**, uploading the certificate InCommon signs each with.
   Get it from InCommon's site and check its fingerprint against what they publish. Use *Refresh* and confirm entities appear
   under *Imported entities*.
3. Fill in **Federation identity** (scope, organization, contacts; SIRTFI only if you meet it), enable it, and save. Keys are
   generated on first save.
4. Download `/fed/idp/metadata` and submit it in InCommon's registration tool (Federation Manager) as your identity provider.
   To accept sign-ins from other institutions, also submit `/fed/sp/metadata` as a service provider.
5. Use *Preview attribute release* with a real service provider and person, and check the result against what that service
   provider needs, before you announce it.

### Running it day to day

- **Alerts.** The Federation module (and the Dashboard) lists problems as they arise: a source that cannot be refreshed, one that has
  gone quiet, metadata about to expire, the pinned signing certificate or your own keys nearing expiry, and a half-finished key
  rollover. Serious ones are also written to the server log each refresh cycle.
- **Expired metadata is not trusted.** If a source cannot be refreshed before its `validUntil`, its entities stop being used
  rather than being served stale; sign-in through them stops until it refreshes. Refresh problems therefore show up as errors
  well before that point.
- **Rolling keys.** Under *Keys*: **Stage a new key** (published in metadata, not used), submit your updated metadata to the
  federation, wait until it is live, **Activate** (new key signs; the old one stays published and can still decrypt), then
  **Retire** the old key once nothing depends on it. Signing and encryption keys roll together, for the identity and for the
  service provider separately. Generated keys last ten years; alerts start 90 days before expiry.

### Docker

```
docker build -t simple-idp .
docker run -p 3000:3000 -v idp-data:/app/data -e BASE_URL=https://idp.example.net -e TRUST_PROXY=true -e ADMIN_PASSWORD=... simple-idp
```

`docker-compose.yml` is an example behind a TLS-terminating proxy. State (database, generated keys) lives in the `/app/data`
volume; back it up, since it holds the federation keys. The image runs plain HTTP by default (`PROTOCOL=http`, `TLS=false`);
set `PROTOCOL=https TLS=true` to have the app serve TLS itself. The proxy must send `X-Forwarded-Proto: https`.
Private keys are stored unencrypted in the database, so protect that volume accordingly.

### Upgrading in place

`scripts/upgrade.js` (`npm run upgrade -- ...`) upgrades an installed server from a release you downloaded, with a backup and a way back. Stop the server first.

    npm run upgrade -- ~/Downloads                 # newest Pons Identity release (folder, .zip or .tar.gz) in that folder
    npm run upgrade -- ./simple-idp-1.2.0.tar.gz   # or point at one release
    npm run upgrade -- --dry-run ~/Downloads       # say what would happen, change nothing
    npm run upgrade -- list                        # the backups
    npm run upgrade -- rollback [<id>|latest]      # put the previous version back

It checks the release (same product, newer version, Node version, database integrity), prepares it in a staging folder (installs dependencies if `package-lock.json` changed, and builds the web console if the release has none: needs network and npm), then **backs up** the code, `config.json` and a consistent copy of the database to `upgrade-backups/`, swaps the code in (leaving `data/`, `config.json` and `node_modules` unless it changed) and runs the **migration**: the new code upgrades the database schema as it loads, runs the release's optional `scripts/post-upgrade.js`, then starts once on a spare port and must answer a request. If anything fails after the backup, everything, database included, is **rolled back automatically**. `rollback` later restores a backup the same way, with the database as it was before that upgrade (a copy of the current one is kept in the backup; `--keep-data` restores only the code). The five newest backups are kept (`--keep`). The server writes `data/server.pid` so the tool can refuse to run while it is up (`--force` overrides). In Docker, replace the image instead of upgrading inside the container.

### Not yet covered

Front-channel logout in either direction (signing out here does not sign out of the institution, and an institution cannot sign
people out here), and a standalone discovery service for other applications.
