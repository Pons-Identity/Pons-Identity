// Help articles for identity federation: joining InCommon or another SAML federation, registering a single partner
// without a federation, signing in people from other institutions, and running it day to day. Blocks are described in
// integrations.js.

import { holds } from './visibility.js';

const view = holds('federation.view');
const manage = holds('federation.manage');

export const FEDERATION_ARTICLES = [
  {
    slug: 'fed-incommon-overview',
    section: 'Federation',
    title: 'Join InCommon: overview',
    summary: 'What joining InCommon involves, and what you need before you start.',
    visible: view,
    body: [
      'Joining InCommon lets InCommon service providers sign in your people, and, if you choose, lets your people sign in to other institutions. The steps are in this order, under **Federation** in the module menu.',
      { steps: [
        'Add the InCommon metadata sources, so Pons Identity can find every InCommon entity.',
        'Fill in the federation identity: scope, organization, contacts and keys.',
        'Choose which attributes federation service providers receive.',
        'Register Pons Identity with InCommon, then test a sign-in.',
        'Optionally, sign people in from other institutions.',
      ] },
      { heading: 'Before you start' },
      { bullets: [
        'Your institution is an InCommon member, and someone there can register entities in the federation.',
        'You have chosen the final public name for Pons Identity, such as `idp.example.edu`. Entity IDs and endpoints are built from it. Changing it later means registering again with InCommon and every service provider.',
        'The name has a certificate that browsers and service providers trust. Pons Identity\'s own certificate is self-signed, and service providers that fetch metadata over HTTPS will reject it.',
        'You have your organization\'s name, display name and URL, and technical, support and (if you claim SIRTFI) security contacts.',
        'The people doing this have *View federation* and *Manage federation*. Accepting a first-time federated sign-in also needs *Manage users*.',
      ] },
      { tip: 'Set the public name with `BASE_URL` before you do anything else. Put it behind a proxy that sends `X-Forwarded-Proto: https` and set `TRUST_PROXY=true`.' },
    ],
  },
  {
    slug: 'fed-incommon-sources',
    section: 'Federation',
    title: 'Add the InCommon metadata sources',
    summary: 'Add the identity-provider list and the MDQ service, each pinned to InCommon\'s certificate.',
    visible: manage,
    body: [
      'A metadata source is signed metadata. Pons Identity uses it only if it verifies against the certificate you enter for that source, so the certificate is the root of trust. Get it from InCommon\'s site and compare its fingerprint with the one InCommon publishes before you save it.',
      { steps: [
        'Open **Federation**, then the **Federation settings** tab. Under **Metadata sources**, select **Add InCommon IdP list**. Set **Keep** to **Identity providers only**, paste the certificate and save. This list is small, and it fills the institution picker.',
        'Select **Add InCommon MDQ**, paste the certificate for the MDQ service and save. Entities are then fetched one at a time, when a service provider or a person asks for them.',
        'On the MDQ source, select **Test lookup** and enter a known InCommon entity ID. This proves the address and certificate work.',
        'On the identity-provider list, select **Refresh** and confirm entities appear under **Imported entities**.',
      ] },
      { table: {
        head: ['Source', 'Address (confirm with InCommon first)', 'Why you need it'],
        rows: [
          ['Identity-provider list', '`https://md.incommon.org/InCommon/InCommon-metadata-idp-only.xml`', 'The list of institutions for federated sign-in. An MDQ service cannot provide it.'],
          ['MDQ service', '`https://mdq.incommon.org`', 'Service providers, fetched only when they appear, so the database stays small.'],
        ],
      } },
      'The two may be signed by different certificates, so pin each source\'s own. InCommon publishes its signing certificates and fingerprints at https://ops.incommon.org/inc_md_cert.html. Check these addresses against InCommon\'s current documentation before you rely on them.',
      { tip: 'Metadata that has expired is not used. If a source cannot be refreshed before its validity ends, sign-in through its entities stops until the next successful refresh.' },
    ],
  },
  {
    slug: 'fed-incommon-identity',
    section: 'Federation',
    title: 'Set the federation identity',
    summary: 'Scope, organization, contacts and SIRTFI for Pons Identity as an identity provider in the federation.',
    visible: manage,
    body: [
      'The federation identity is one entity ID and one set of keys for every federation service provider. Apps registered by hand keep their own identity. Fill it in under **Federation settings**, in **Federation identity**.',
      { bullets: [
        '**Scope**: the domain that your people\'s scoped attributes use, such as `example.edu`. It must be a domain name.',
        '**Organization**: name, display name and URL.',
        '**Contacts**: technical, support and, if you claim SIRTFI, security. Each needs an email address.',
        '**SIRTFI**: tick it only if your institution meets the SIRTFI requirements.',
        '**Attributes**: the affiliation sent when none is known, the source of `eduPersonPrincipalName`, and any group-to-affiliation mappings.',
      ] },
      { steps: [
        'Enter the values above and turn on **Enabled**.',
        'Select **Save**. Keys are generated on the first save. They are separate from the TLS certificate.',
        'Check the metadata URLs in the **Federation identity** panel: **Metadata** (the unsigned copy to submit to InCommon), **Signed metadata**, **SSO**, **SLO** and **Initiated sign-in**.',
      ] },
      { tip: 'Use the signed metadata only where a consumer fetches it directly. It carries a validity of 14 days. The unsigned copy is what you submit to a federation\'s registration tool.' },
    ],
  },
  {
    slug: 'fed-incommon-release',
    section: 'Federation',
    title: 'Choose attribute release for federation service providers',
    summary: 'Switch on the entity categories you support, and check the result for a real service provider.',
    visible: manage,
    body: [
      'A federation service provider receives nothing by default. It receives an attribute only if it belongs to a category you have switched on, or if it marks the attribute as required and you have set **Release required attributes**.',
      { table: {
        head: ['Category', 'What it releases', 'Use it for'],
        rows: [
          ['REFEDS Research & Scholarship', 'Name, email, scoped affiliation and a targeted ID.', 'Research services.'],
          ['REFEDS Pseudonymous Access', 'A pairwise ID, scoped affiliation and home organization.', 'Services that need no identity.'],
          ['REFEDS Personalized Access', 'A subject ID, email, name, scoped affiliation and home organization.', 'Services that need a personal identity.'],
          ['REFEDS Anonymous Access', 'Scoped affiliation and home organization only.', 'Services that need only membership.'],
          ['GÉANT Code of Conduct', 'Whatever the service provider requests that you can supply.', 'Services that follow the Code of Conduct.'],
        ],
      } },
      { steps: [
        'Open the **Attribute release** tab and switch on the categories you support. Save.',
        'Select **Preview attribute release**, choose a real service provider and a real person, and compare the result with what that service provider needs.',
      ] },
      'The category bundles are defined in `src/federation/release-policy.js`. Check them against the current REFEDS and InCommon specifications before you go to production.',
      { tip: 'A hand-registered application with the same entity ID as a federation service provider keeps its own attribute mapping, rules and access settings. Only the issuer, keys and endpoints come from the federation.' },
    ],
  },
  {
    slug: 'fed-incommon-register',
    section: 'Federation',
    title: 'Register Pons Identity with InCommon',
    summary: 'Submit your identity provider and, optionally, your service provider metadata to InCommon.',
    visible: manage,
    body: [
      { steps: [
        'Open **Federation** and copy the **Metadata** URL, `https://idp.example.edu/fed/idp/metadata`. Download the file.',
        'Submit it in InCommon\'s registration tool (Federation Manager) as an identity provider.',
        'If you want your people to sign in to other institutions, enable **Sign in from other institutions** (see the next article), copy `https://idp.example.edu/fed/sp/metadata` and submit it as a service provider.',
        'Wait until the registration appears in InCommon\'s published metadata, then confirm that the same source you added earlier now lists your entity.',
        'Test a sign-in with an InCommon test service provider, and check the attributes received against the release settings.',
      ] },
      { tip: 'Changing the base URL or the entity ID means registering again. Keep the public name stable.' },
    ],
  },
  {
    slug: 'fed-incommon-other-institutions',
    section: 'Federation',
    title: 'Sign people in from other institutions',
    summary: 'Let your people sign in to other institutions, and decide how their first sign-in is handled.',
    visible: manage,
    body: [
      'Turn on **Sign in from other institutions** under **Federation**, in the **Other institutions** tab. A **Sign in with your institution** button then appears on the sign-in page. People pick their institution from the imported metadata, sign in there and return to Pons Identity.',
      { bullets: [
        '**Allow list**: optionally, limit the institutions to entity IDs you list, one per line.',
        '**Account creation**: by default, a first-time sign-in waits in **People from other institutions** until an administrator approves it. Approval creates an account with no usable password, or links the sign-in to an existing user. You can instead create accounts automatically; combine that with an allow list.',
      ] },
      { heading: 'What is checked' },
      { bullets: [
        'The response replies to a request this session started, is signed by a key in the institution\'s own published metadata, has not expired, is addressed to this service provider, and has not been used before.',
        'Encrypted assertions are decrypted with this service provider\'s key. RSA 1.5 key transport is refused.',
        'People are matched only on an identifier the institution is authoritative for: a pairwise ID, a subject ID, a persistent ID, or an eduPersonPrincipalName whose domain is a scope in the institution\'s metadata. People are never matched to a local account by email address.',
        'A policy that blocks sign-in blocks this route too. A policy that requires multi-factor sign-in is met only if the institution reports the REFEDS MFA profile.',
      ] },
      { tip: 'The session cookie is `SameSite=None`, which Pons Identity sets only over HTTPS. Plain-HTTP setups cannot complete this flow.' },
    ],
  },
  {
    slug: 'fed-generic-overview',
    section: 'Federation',
    title: 'Connect to another federation or partner: overview',
    summary: 'Choose between joining a SAML federation other than InCommon, and registering one partner directly.',
    visible: view,
    body: [
      'Pons Identity can take part in any SAML 2.0 federation, not only InCommon. The federation features are generic: a metadata source is any HTTPS metadata file or MDQ service, verified against a certificate you enter for it. The InCommon presets are shortcuts only. Choose the path that matches your situation.',
      { table: {
        head: ['Situation', 'Use', 'Start with'],
        rows: [
          ['Your federation publishes metadata and you want its service providers to sign in your people', 'Join a federation', 'Join a federation other than InCommon'],
          ['You want to sign in people from the federation\'s other institutions', 'Join a federation, then enable sign-in from other institutions', 'Sign in people from another federation\'s institutions'],
          ['One partner exchanges metadata with you directly, with no federation', 'Register a partner', 'Register a single partner without a federation'],
        ],
      } },
      { tip: 'Get every signing certificate from the operator through a channel you trust, such as a signed letter or a call to a known contact, and check its fingerprint. Metadata is trusted only against the certificate you pin.' },
    ],
  },
  {
    slug: 'fed-generic-join',
    section: 'Federation',
    title: 'Join a federation other than InCommon',
    summary: 'Add the federation\'s metadata, set your identity, and register with the federation operator.',
    visible: manage,
    body: [
      { steps: [
        'Open **Federation** and, under **Metadata sources**, select **Add source**. Enter a name for it.',
        'Choose the kind. Use **Metadata file** for a signed aggregate of the federation. Use **MDQ service** if the operator offers one, and enter its base URL, without `/entities`.',
        'Enter the URL, which must be https. Paste the operator\'s signing certificate, and save.',
        'For a metadata file, choose **Keep**. Choose **Identity providers only** if you only sign people in from other institutions, and **Service providers only** if you only serve the federation\'s service providers. Choose **Everything** only when you need both.',
        'Set the **Refresh interval**, between 1 and 168 hours. Select **Refresh** and confirm that entities appear under **Imported entities**.',
        'For an MDQ service, select **Test lookup** with a known entity ID.',
        'Fill in **Federation identity** (scope, organization, contacts and keys), turn it on and save.',
        'Give the operator the metadata URL from **Federation identity**, and ask them to register it with the federation.',
      ] },
      { heading: 'Check before you go live' },
      { bullets: [
        'Use **Preview attribute release** with a real service provider from the federation and a real person.',
        'Check that the federation\'s service providers receive the attributes they need. The release bundles work from the REFEDS and Code of Conduct categories in each service provider\'s metadata. A federation that does not publish those categories gets nothing by default. Ask the operator which attributes its service providers need, and set **Release required attributes** if they mark them as required.',
      ] },
      { tip: 'Metadata that expires before it can be refreshed is not used. Watch the alerts on the Dashboard and in the Federation module.' },
    ],
  },
  {
    slug: 'fed-generic-partner',
    section: 'Federation',
    title: 'Register a single partner without a federation',
    summary: 'Add a SAML service provider or identity provider by its metadata, with no federation in between.',
    visible: manage,
    body: [
      'Use this for a partner that exchanges metadata with you directly. Each partner is registered as its own application, under **Applications**.',
      { heading: 'A service provider that signs in through Pons Identity' },
      { steps: [
        'Open **Applications**, select **New application**, then **SAML 2.0**. Enter the name.',
        'In **SP metadata**, paste the partner\'s metadata XML, upload a file, or enter its metadata URL, then parse it. Parsing fills in the assertion consumer URLs, the logout URL, the signing and encryption certificates and the requested attributes.',
        'Check the **NameID** setting, the signing and encryption options, and the attribute mapping for each attribute the partner requests. Set access rules if only some people should use the application.',
        'Give the partner your metadata from `/saml/<id>/metadata`. Use the **Preview** to check the attributes a person would receive.',
      ] },
      { heading: 'A partner whose sign-in you accept' },
      'To accept sign-ins from a partner\'s identity provider, add that identity provider\'s metadata as a metadata source for the same federation or on its own, as described in the article on joining a federation. Then enable sign-in from other institutions and list the partner on the allow list.',
      { tip: 'Metadata that you paste or fetch for a partner is not checked against a signature. Confirm the partner\'s certificates through a channel you trust before you save them.' },
    ],
  },
  {
    slug: 'fed-generic-sign-in',
    section: 'Federation',
    title: 'Sign people in from another federation\'s institutions',
    summary: 'Use the same sign-in route for any federation, with its own allow list and account rules.',
    visible: manage,
    body: [
      'The route works the same way for any federation. Turn on **Sign in from other institutions** under **Federation**, and register the metadata URL from **Sign in from other institutions** with the federation as a service provider.',
      { bullets: [
        'List the federation\'s institutions you accept, one entity ID per line, in the allow list. Leave it empty to accept every institution in the imported metadata.',
        'Decide the account rule: approval by an administrator (the default), or automatic creation combined with an allow list.',
        'A policy that requires multi-factor sign-in is met only when the institution reports the REFEDS MFA profile. Check the policies that apply to your people before you turn this on, because an institution that does not report it cannot meet such a policy.',
      ] },
      { tip: 'Institutions are matched on the identifiers listed under the InCommon article on other institutions. Check that the federation\'s institutions publish one of them.' },
    ],
  },
  {
    slug: 'fed-operations',
    section: 'Federation',
    title: 'Run federation day to day',
    summary: 'Alerts, refresh errors, key rollover, backups and the limits of the current federation support.',
    visible: view,
    body: [
      { heading: 'Alerts' },
      'The Federation module and the Dashboard list problems as they arise: a source that cannot be refreshed, a source that has gone quiet, metadata about to expire, a pinned signing certificate or your own keys nearing expiry, and a half-finished key rollover. Serious ones also appear in the server log at each refresh.',
      { heading: 'Expired metadata' },
      'If a source cannot be refreshed before its validity ends, its entities stop being used. Sign-in through them stops until the next successful refresh. Act on refresh errors well before that point.',
      { heading: 'Rolling keys' },
      { steps: [
        'Under **Keys**, select **Stage a new key**. It is published in metadata but not used.',
        'Submit the updated metadata to the federation and wait until it is live.',
        'Select **Activate**. The new key signs from then on, and the old one stays published so it can still decrypt.',
        'Select **Retire** on the old key once nothing depends on it.',
      ] },
      'Signing and encryption keys roll together, separately for the identity and for the service provider. Generated keys last ten years, and alerts start 90 days before expiry.',
      { heading: 'Backups' },
      'The data volume holds the federation keys and the database. Back it up, and test a restore. The keys are stored unencrypted in the database, so protect the volume.',
      { heading: 'Not yet covered' },
      { bullets: [
        'Front-channel logout in either direction. Signing out of Pons Identity does not sign people out of the other institution, and the other institution cannot sign people out here.',
        'A standalone discovery service for applications other than the institution picker.',
      ] },
    ],
  },
];
