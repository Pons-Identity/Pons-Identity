// Help articles for single sign-on: setting up SAML 2.0, CAS, OpenID Connect and OAuth 2.0 applications, and the
// reference for their endpoints, values and errors. Block types are described in integrations.js.

import { holds } from './visibility.js';

const view = holds('sps.view');
const manage = holds('sps.manage');

export const PROTOCOL_ARTICLES = [
  {
    slug: 'sso-choose-protocol',
    section: 'Single sign-on',
    title: 'Choose a sign-in protocol',
    summary: 'Pick SAML 2.0, OpenID Connect, OAuth 2.0 or CAS for an application.',
    visible: view,
    body: [
      'Every application under **Applications** uses one protocol. Choose the one the application already supports. If it supports more than one, prefer OpenID Connect for new work, or SAML 2.0 for enterprise web applications that expect assertions.',
      { table: {
        head: ['Protocol', 'Use it for', 'Endpoints start at', 'Default subject', 'What the app receives'],
        rows: [
          ['SAML 2.0', 'Enterprise web applications that expect signed XML assertions.', '`/saml/<id>/`, one set per application', 'The **Name ID Attribute** (default `email`)', 'A signed (and optionally encrypted) assertion, posted to the ACS URL.'],
          ['OpenID Connect', 'Web, mobile and single-page applications that need identity and tokens.', '`/oidc/`', 'The GUID, unless you choose another attribute', 'An ID token (a signed RS256 JWT) and an access token.'],
          ['OAuth 2.0', 'Applications and services that need an access token, with or without a user.', '`/oauth2/`', 'The GUID', 'An access token, and a refresh token for user sign-ins.'],
          ['CAS', 'Applications built for the CAS protocol.', '`/cas/`', 'The username', 'A single-use service ticket, validated on the server.'],
        ],
      } },
      { tip: 'The page shows only the settings for the protocol you chose. A CAS application has no client ID or client secret.' },
    ],
  },
  {
    slug: 'sso-saml-add',
    section: 'Single sign-on',
    title: 'Add a SAML 2.0 application',
    summary: 'Register a service provider, set its ACS URL and release the right values.',
    visible: manage,
    body: [
      { steps: [
        'Open **Applications** and select **New application**, then **SAML 2.0**.',
        'Type the **Application Name** and an optional **Application Description**.',
        'Give the application the IdP details shown in **IdP metadata**: the **Entity ID**, the **SSO URL**, the **SLO URL** and the metadata XML. The application may also need the certificate fingerprints.',
        'Under **Metadata discovery**, choose how the service provider is described: by hand (no metadata), by a **Metadata URL**, or by uploading a **Metadata XML file**. If you use a URL or file, the **Entity ID** and **ACS URL** fill in for you.',
        'Check the **Entity ID** (the service provider\'s entity ID). Enter one **ACS URL** for each address where the application receives assertions. At least one is required, and each must be an `http` or `https` address.',
        'Enter the **Service Provider Login URL**, **SLO URL** and **Default Relay State** only if the application needs them. The default relay state is sent with IdP-initiated sign-on, and it is limited to 80 bytes.',
        'Under the response options, choose the **Name ID Format** and the **Name ID Attribute**, then the **Signature Algorithm**. Leave **Sign response** and **Sign assertion** on unless the application says otherwise.',
        'Turn on **Encrypt assertions** only if the application gives you an **Encryption certificate file**. Choose the **Assertion encryption algorithm** and **Key transport encryption algorithm** it supports.',
        'Add the **Attribute mapping**, **Static value** and role rows you need. See [Release attributes to a SAML application](/help/sso-saml-attributes).',
        'Under user access, choose who may sign in: nobody, specific groups, or everyone.',
        'Save the application.',
      ] },
      { heading: 'Defaults for a new SAML application' },
      { table: {
        head: ['Setting', 'Default'],
        rows: [
          ['Name ID Format', '`emailAddress`'],
          ['Name ID Attribute', '`email`'],
          ['Signature Algorithm', '`sha256`'],
          ['Sign response / Sign assertion', 'On / On'],
          ['Encrypt assertions', 'Off'],
          ['Assertion encryption algorithm', '`aes256-cbc`'],
          ['Key transport encryption algorithm', '`rsa-oaep-mgf1p`'],
          ['Attribute transformations', 'Enabled'],
          ['User access', '`all`'],
        ],
      } },
      { tip: 'Give the application a **Request signing certificate file** only when it signs its own requests. Once a certificate is registered, an AuthnRequest without a valid signature is refused.' },
    ],
  },
  {
    slug: 'sso-saml-attributes',
    section: 'Single sign-on',
    title: 'Release attributes to a SAML application',
    summary: 'Map what you know about a person to the names an application expects.',
    visible: manage,
    body: [
      { heading: 'Map an attribute' },
      { steps: [
        'Open the SAML application and find **Attribute mapping**.',
        'Add a row, then choose **IdP attribute** as the kind, and pick the attribute from the list.',
        'Type the **Attribute name the SP expects**, exactly as the application documents it, such as `mail`, `uid`, or a URN such as `urn:oid:0.9.2342.19200300.100.1.3`.',
        'Save the application.',
      ] },
      'For a fixed value that every person receives, choose **Static value** as the kind, and type the value.',
      { heading: 'Release roles from groups' },
      'Type the **Attribute name the SP expects** under **Role attributes**. Then add a **Role mapping** for each role value the application expects: type the **SP role**, and choose the **IdP groups** whose members receive it. A person in any of those groups receives the role under that attribute name. The same attribute also carries every group name the person belongs to.',
      { heading: 'Transform values' },
      { steps: [
        'Open **Attribute transformations** and tick **Enable attribute transformations**.',
        'Write one rule per line in the form `target = expression`. A line that starts with `#` is a comment.',
        'Choose **Preview as user**, pick a person, and check the **Attribute preview** before you save.',
        'To use a transformed attribute as the NameID, tick **Set this as my NameID attribute** on that rule.',
        'To use an attribute only while building the rules, tick **Use as temporary attribute**. It is dropped before the assertion is sent.',
      ] },
      { code: `# Lower-case the mail address the application receives
mail = lower(email)
# Build a principal name from the username
upn = concat(username, "@example.net")
# Keep only the part of the department before a dash
department = extract(department, "^([^-]+)", 1)
# Use the first group as a single value
primary_group = first(groups)` },
      { heading: 'Expression rules' },
      { table: {
        head: ['Expression', 'Arguments', 'What it does'],
        rows: [
          ['`"text"`, `42`', '', 'A literal string or number.'],
          ['`name`', '', 'The value of an attribute already produced by a mapping, or an IdP attribute such as `email` or `custom:badge`.'],
          ['`lower(x)`, `upper(x)`, `trim(x)`', '1', 'Change case, or remove spaces at each end.'],
          ['`first(x)`', '1', 'The first value only.'],
          ['`join(x, sep)`', '2', 'Joins the values with `sep`.'],
          ['`concat(a, b, ...)`', '1 or more', 'Joins the parts into one value. Blank parts count as empty.'],
          ['`coalesce(a, b, ...)`', '1 or more', 'The first argument that has a non-blank value.'],
          ['`replace(x, pattern, with)`', '3', 'Replaces each match of a regular expression.'],
          ['`extract(x, pattern, group?)`', '2 or 3', 'The text matched by a capture group. The default group is 1.'],
          ['`substring(x, start, length?)`', '2 or 3', 'A slice of the text. Counts from 0.'],
          ['`split(x, sep, index)`', '3', 'The part at `index` after splitting by `sep`. Counts from 0.'],
          ['`attr(name)`', '1', 'The value of an attribute by name.'],
          ['`drop()`', '0', 'Removes the attribute.'],
        ],
      } },
      { tip: 'A rule that fails at run time leaves its target unchanged and reports the error. A rule that cannot be read is reported with its line number.' },
    ],
  },
  {
    slug: 'sso-cas-add',
    section: 'Single sign-on',
    title: 'Add a CAS application',
    summary: 'Register the service URLs a CAS application may return to.',
    visible: manage,
    body: [
      { steps: [
        'Open **Applications** and select **New application**, then **CAS**.',
        'Type the **Application Name** and an optional **Application Description**.',
        'Add the **Service URLs** the application uses. Each one is an exact address, or an address that ends in `*` to match any text after it, such as `https://wiki.example.net/*`.',
        'Under **User identifier**, keep **username** unless the application needs another attribute.',
        'Add any **Attribute mapping** rows the application needs. They appear in the attributes the `p3/serviceValidate` endpoint returns.',
        'Under user access, choose who may sign in.',
        'Save the application, then give the application the endpoints shown on the page: the **Login URL**, the **Logout URL**, the **Validate URL (CAS 1.0)** and the **Service validate URL (CAS 2.0)**. For CAS 3.0, the application uses `/cas/p3/serviceValidate`.',
      ] },
      { tip: 'A CAS ticket is sent only to a service that matches a registered URL. A `*` matches any text, including slashes, so keep the prefix narrow: `https://wiki.example.net/*` is safer than `https://*`.' },
      'For the values each endpoint takes and returns, see [Reference: CAS](/help/reference-cas).',
    ],
  },
  {
    slug: 'sso-oidc-add',
    section: 'Single sign-on',
    title: 'Add an OpenID Connect application',
    summary: 'Register an OpenID Connect client, its redirect URIs, scopes and claims.',
    visible: manage,
    body: [
      { steps: [
        'Open **Applications** and select **New application**, then **OpenID Connect**.',
        'Type the **Application Name** and an optional **Application Description**.',
        'Enter the **Redirect URIs**, one per row. The application\'s sign-in must send one of these exactly. Add **Post-logout redirect URIs** if the application has a sign-out page to return to.',
        'Tick **Confidential client (has a client secret)** for a server-side application. Leave it off for a single-page or mobile application. A public client has no secret, so **Require PKCE** is always on for it.',
        'Under **Allowed scopes**, tick the scopes the application may request. **openid** is always included. **offline_access** is kept only when the **refresh_token** grant is allowed.',
        'Under **Grant types**, leave **authorization_code** and **refresh_token** ticked for the usual flow.',
        'Set **Access token lifetime (seconds)**. It can be from 60 to 86400, and the default is 3600.',
        'Set the **Subject (sub) attribute**. The default is the GUID, which never changes. Choose another attribute only if the application needs a readable value.',
        'Add **Attribute mapping** rows to put extra attributes into claims. Each row maps an IdP attribute to a claim name.',
        'Save. A confidential client\'s **Client secret** is shown once, so copy it before you leave the page. Copy the **Client ID** too.',
      ] },
      { heading: 'Claims the scopes release' },
      { bullets: [
        '`profile`: `name`, `given_name`, `family_name`, `preferred_username`.',
        '`email`: `email`.',
        '`groups`: `groups`, the names of the person\'s groups.',
        'Always: `sub`, the subject, which every ID token carries.',
        'Each attribute mapping adds its claim, using the claim name you chose.',
      ] },
      { tip: 'The application should send `state` and `nonce`, and check that the ID token\'s `nonce` matches what it sent. See [Reference: OpenID Connect](/help/reference-oidc).' },
    ],
  },
  {
    slug: 'sso-oauth2-add',
    section: 'Single sign-on',
    title: 'Add an OAuth 2.0 application',
    summary: 'Register an OAuth 2.0 client, choose its grant types and its scopes.',
    visible: manage,
    body: [
      { steps: [
        'Open **Applications** and select **New application**, then **OAuth 2.0**.',
        'Type the **Application Name** and an optional **Application Description**.',
        'Enter the **Redirect URIs**, one per row, exactly as the application sends them.',
        'Tick **Confidential client (has a client secret)** for a server-side application or a service. A public client must use PKCE.',
        'Tick the **Grant types** the application uses: **authorization_code** for a person signing in, **refresh_token** to renew their tokens, and **client_credentials** for a service that acts in its own name. Client credentials needs a confidential client.',
        'Under **Allowed scopes**, type each scope name, one per row. Unlike OpenID Connect, these names are yours to choose. The names `profile`, `email` and `groups` release the same claims as they do for OpenID Connect.',
        'Set **Access token lifetime (seconds)**, from 60 to 86400.',
        'Set the **Subject (sub) attribute** and any **Attribute mapping** rows, then choose who may sign in.',
        'Save, and copy the **Client secret** when it is shown. It is not shown again.',
      ] },
      { heading: 'Get a token for a service' },
      { code: `curl -s -u "$CLIENT_ID:$CLIENT_SECRET" \\
  -d grant_type=client_credentials \\
  -d scope="reports.read" \\
  https://idp.example.net/oauth2/token` },
      'The reply has an `access_token`, `token_type` of `Bearer`, and `expires_in`. A client credentials token belongs to the application, not a person, so it has no user to return from the userinfo endpoint. See [Reference: OAuth 2.0](/help/reference-oauth2).',
    ],
  },
  {
    slug: 'reference-saml',
    section: 'Single sign-on',
    title: 'Reference: SAML 2.0',
    summary: 'SAML endpoints, NameID formats, algorithms, timing and the checks applied to requests.',
    visible: view,
    body: [
      { heading: 'Endpoints' },
      { table: {
        head: ['Purpose', 'Path', 'Notes'],
        rows: [
          ['IdP metadata for this application', '`/saml/<id>/metadata`', 'Also the **Entity ID** the IdP uses for this application. Each application has its own. `<id>` is the number in the address of the application.'],
          ['Single sign-on', '`/saml/<id>/sso`', 'Accepts `GET` (HTTP-Redirect) and `POST` (HTTP-POST) AuthnRequests.'],
          ['IdP-initiated sign-on', '`/saml/<id>/init`', 'Starts a sign-in with no request. Sends the **Default Relay State**.'],
          ['Single logout', '`/saml/<id>/slo`', 'Accepts `GET` and `POST` LogoutRequests.'],
          ['Resume after sign-in', '`/saml/<id>/resume`', 'Where the browser returns after a sign-in.'],
        ],
      } },
      { heading: 'Name ID formats' },
      { table: {
        head: ['Name ID Format', 'URI'],
        rows: [
          ['`emailAddress` (default)', '`urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`'],
          ['`unspecified`', '`urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified`'],
          ['`persistent`', '`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`'],
          ['`transient`', '`urn:oasis:names:tc:SAML:2.0:nameid-format:transient`. A new random value at every sign-in.'],
        ],
      } },
      { heading: 'Signature algorithms' },
      { table: {
        head: ['Value', 'Signature', 'Digest'],
        rows: [
          ['`sha1`', 'RSA-SHA1 (legacy)', 'SHA-1'],
          ['`sha256` (default)', 'RSA-SHA256', 'SHA-256'],
          ['`sha384`', 'RSA-SHA384', 'SHA-384'],
          ['`sha512`', 'RSA-SHA512', 'SHA-512'],
        ],
      } },
      { heading: 'Encryption' },
      { table: {
        head: ['Setting', 'Values'],
        rows: [
          ['Assertion encryption algorithm', '`aes128-cbc`, `aes192-cbc`, `aes256-cbc` (default), `aes128-gcm`, `aes192-gcm`, `aes256-gcm`'],
          ['Key transport encryption algorithm', '`rsa-oaep-mgf1p` (RSA-OAEP with SHA-1, default), `rsa-oaep-sha256`'],
        ],
      } },
      { heading: 'Assertion contents' },
      { table: {
        head: ['Element', 'Value'],
        rows: [
          ['`Issuer`', 'The application\'s own **Entity ID** (the IdP metadata address).'],
          ['`Audience`', 'The application\'s **Entity ID**. If it has none, the ACS URL.'],
          ['`NotBefore`', 'Two minutes before issue, to allow for clock differences.'],
          ['`NotOnOrAfter`', 'Five minutes after issue. Set on the conditions and on the subject confirmation.'],
          ['`Recipient`, `InResponseTo`', 'The ACS URL the request came from, and the request\'s ID.'],
          ['`AuthnContextClassRef`', '`urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken` when the person used an authenticator app code. Otherwise `urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport`.'],
          ['`amr` attribute', 'The methods used at sign-in: `pwd`, `otp` or `mfa`. Not sent to federation applications.'],
          ['Microsoft AMR claim', '`http://schemas.microsoft.com/claims/authnmethodsreferences`, with `…/authenticationmethod/password` and/or `…/claims/multipleauthn`. Not sent to federation applications.'],
        ],
      } },
      { heading: 'Checks on an AuthnRequest' },
      { bullets: [
        'The request\'s `Issuer` must equal the application\'s **Entity ID**. Otherwise the server shows an error.',
        'If a request signing certificate is registered, the request must be signed by it.',
        'The request\'s ACS URL must be one of the application\'s registered ACS URLs. A request with another ACS URL is refused, so a request cannot send the assertion somewhere else.',
        '`ForceAuthn="true"` makes the person sign in again, even with a live session.',
      ] },
      { heading: 'Sign-out' },
      'Logout requests go to `/saml/<id>/slo`. The **SLO URL** on the application is its single logout address. Set it when the application supports single logout.',
      { tip: 'Attribute names and the NameID source use the same list of attributes. For what each name means, see [Reference: attribute names](/help/reference-attribute-names).' },
    ],
  },
  {
    slug: 'reference-cas',
    section: 'Single sign-on',
    title: 'Reference: CAS',
    summary: 'CAS endpoints, parameters, ticket rules, responses and error codes.',
    visible: view,
    body: [
      { heading: 'Endpoints' },
      { table: {
        head: ['Path', 'Parameters', 'What it does'],
        rows: [
          ['`/cas/login`', '`service` (required), `renew`, `gateway`', 'Signs the person in if needed, then redirects to `service?ticket=ST-…`. With `renew=true`, the person must sign in again if their session is more than 120 seconds old. With `gateway=true` and no session, it redirects straight back to `service` without a ticket.'],
          ['`/cas/serviceValidate`', '`ticket`, `service`', 'CAS 2.0 validation. Returns an XML `serviceResponse`.'],
          ['`/cas/p3/serviceValidate`', '`ticket`, `service`', 'CAS 3.0 validation. As above, plus the `cas:attributes` element.'],
          ['`/cas/validate`', '`ticket`, `service`', 'CAS 1.0 validation. Returns plain text: `yes` and the username on two lines, or `no`.'],
          ['`/cas/logout`', '`service` (CAS 3.0) or `url` (CAS 2.0)', 'Signs the person out. Redirects only to a registered service URL.'],
        ],
      } },
      { heading: 'Ticket rules' },
      { bullets: [
        'Tickets start with `ST-`. Only service tickets are issued and accepted. Proxy tickets are not implemented.',
        'A ticket is valid for 300 seconds and can be used once. Validation spends it.',
        'A ticket works only with the `service` it was issued for.',
        'With `renew=true` at validation, the ticket must come from a fresh sign-in.',
      ] },
      { heading: 'A successful CAS 2.0 response' },
      { code: `<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
  <cas:authenticationSuccess>
    <cas:user>srivera</cas:user>
  </cas:authenticationSuccess>
</cas:serviceResponse>` },
      { heading: 'A CAS 3.0 response with attributes' },
      'The `cas:attributes` element holds every mapped attribute, plus three fixed ones:',
      { table: {
        head: ['Element', 'Value'],
        rows: [
          ['`authenticationDate`', 'The ISO time of the sign-in.'],
          ['`isFromNewLogin`', '`true` if the person signed in within the last two minutes, otherwise `false`.'],
          ['`longTermAuthenticationRequestTokenUsed`', 'Always `false`.'],
        ],
      } },
      { heading: 'Failure response' },
      { code: `<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
  <cas:authenticationFailure code="INVALID_TICKET">Ticket ST-… is unknown, expired or already used.</cas:authenticationFailure>
</cas:serviceResponse>` },
      { table: {
        head: ['Code', 'When'],
        rows: [
          ['`INVALID_REQUEST`', '`service` or `ticket` is missing.'],
          ['`INVALID_TICKET_SPEC`', 'The ticket does not start with `ST-`.'],
          ['`INVALID_TICKET`', 'The ticket is unknown, expired, already used, not from a fresh sign-in when `renew` is set, or the account can no longer sign in.'],
          ['`INVALID_SERVICE`', 'The ticket was issued for a different `service`.'],
        ],
      } },
      { tip: 'Validate tickets from the application\'s server, not from a browser. A ticket is spent by the first validation, whatever the outcome.' },
    ],
  },
  {
    slug: 'reference-oidc',
    section: 'Single sign-on',
    title: 'Reference: OpenID Connect',
    summary: 'OpenID Connect endpoints, the discovery document, claims, lifetimes and errors.',
    visible: view,
    body: [
      { heading: 'Endpoints' },
      { table: {
        head: ['Purpose', 'Path'],
        rows: [
          ['Discovery', '`/oidc/.well-known/openid-configuration`'],
          ['Authorization', '`/oidc/authorize`'],
          ['Token', '`/oidc/token`'],
          ['UserInfo', '`/oidc/userinfo` (`GET` or `POST`)'],
          ['Signing keys', '`/oidc/jwks`'],
          ['Introspection', '`/oidc/introspect` (confidential clients only)'],
          ['Revocation', '`/oidc/revoke`'],
          ['End session (logout)', '`/oidc/logout`'],
        ],
      } },
      'The discovery, token, UserInfo, JWKS, introspection and revocation endpoints accept requests from any origin. None of them depends on a browser cookie.',
      { heading: 'Discovery document' },
      { table: {
        head: ['Field', 'Value'],
        rows: [
          ['`issuer`', '`<base>/oidc`'],
          ['`response_types_supported`', '`["code"]`'],
          ['`grant_types_supported`', '`["authorization_code", "refresh_token"]`'],
          ['`code_challenge_methods_supported`', '`["S256"]`'],
          ['`token_endpoint_auth_methods_supported`', '`client_secret_basic`, `client_secret_post`, `none`'],
          ['`id_token_signing_alg_values_supported`', '`["RS256"]`'],
          ['`subject_types_supported`', '`["public"]`'],
          ['`scopes_supported`', '`openid`, `profile`, `email`, `groups`, `offline_access`'],
        ],
      } },
      { heading: 'Authorization request' },
      { table: {
        head: ['Parameter', 'Required', 'Notes'],
        rows: [
          ['`client_id`', 'Yes', 'The application\'s **Client ID**.'],
          ['`redirect_uri`', 'Yes', 'Must match a registered redirect URI exactly.'],
          ['`response_type`', 'Yes', '`code` only.'],
          ['`scope`', 'Yes', 'Must include `openid`, and may use only the application\'s allowed scopes.'],
          ['`state`', 'Recommended', 'Returned unchanged on the redirect.'],
          ['`nonce`', 'Recommended', 'Copied into the ID token.'],
          ['`code_challenge`, `code_challenge_method`', 'Required for public clients and when PKCE is required', '`S256` only.'],
          ['`prompt`', 'No', '`login` asks the person to sign in again. `none` returns `login_required` instead of showing a page.'],
          ['`max_age`', 'No', 'Asks for a fresh sign-in when the session is older than this many seconds.'],
        ],
      } },
      'The redirect back carries `code`, `state`, and `iss` (the issuer).',
      { heading: 'Token request' },
      { table: {
        head: ['Grant', 'Parameters'],
        rows: [
          ['`authorization_code`', '`code`, `redirect_uri` (must match the request), `code_verifier` (when PKCE was used)'],
          ['`refresh_token`', '`refresh_token`, and optionally `scope`, which may only narrow the original scope'],
        ],
      } },
      'Authenticate the client with HTTP Basic (`client_id` and `client_secret`) or with the `client_id` and `client_secret` form fields. A public client sends only its `client_id`, with PKCE.',
      { heading: 'Token response' },
      { code: `{
  "access_token": "…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "openid profile email offline_access",
  "id_token": "eyJhbGciOiJSUzI1NiIs…",
  "refresh_token": "…"
}` },
      { bullets: [
        '`id_token` is returned when the `openid` scope was granted.',
        '`refresh_token` is returned when `offline_access` was granted and the `refresh_token` grant is allowed.',
        'Access tokens are random strings, not JWTs. Check them with introspection, or with the UserInfo endpoint.',
        'A refresh token is used once. Each refresh returns a new one.',
      ] },
      { heading: 'ID token claims' },
      { table: {
        head: ['Claim', 'Value'],
        rows: [
          ['`iss`', 'The issuer, `<base>/oidc`.'],
          ['`aud`', 'The application\'s **Client ID**.'],
          ['`sub`', 'The subject, from the **Subject (sub) attribute**.'],
          ['`iat`, `exp`', 'Issue time, and expiry. `exp` is the access token lifetime after `iat`.'],
          ['`auth_time`', 'When the person last signed in, as a Unix time.'],
          ['`amr`', 'The methods used at sign-in, such as `pwd` and `otp`.'],
          ['`nonce`', 'Present when the request had one.'],
          ['`at_hash`', 'A hash of the access token, for checking it belongs to this ID token.'],
          ['scope claims', 'Those listed under [Claims the scopes release](/help/sso-oidc-add), and each mapped claim.'],
        ],
      } },
      { heading: 'Lifetimes' },
      { table: {
        head: ['Token', 'Lifetime'],
        rows: [
          ['Authorization code', '60 seconds, used once.'],
          ['Access token', 'The application\'s **Access token lifetime**: 60 to 86400 seconds, default 3600.'],
          ['Refresh token', '30 days. Rotated at each use.'],
        ],
      } },
      { heading: 'Errors' },
      { table: {
        head: ['Error', 'Where', 'Meaning'],
        rows: [
          ['`invalid_request`', 'Redirect or token response', 'A parameter is missing or wrong, or PKCE is required.'],
          ['`unsupported_response_type`', 'Redirect', '`response_type` is not `code`.'],
          ['`unauthorized_client`', 'Redirect or token response', 'The client may not use that grant type.'],
          ['`invalid_scope`', 'Redirect or token response', 'The `openid` scope is missing, or a scope is not allowed.'],
          ['`login_required`', 'Redirect', '`prompt=none` was sent, and the person is not signed in.'],
          ['`invalid_grant`', 'Token response', 'The code or refresh token is unknown, expired, used, or the PKCE check or redirect URI failed.'],
          ['`invalid_client`', 'Token or introspection response, with HTTP 401', 'Client authentication failed.'],
          ['`invalid_token`', 'UserInfo, with HTTP 401', 'The access token is unknown, expired or not for a user.'],
          ['`insufficient_scope`', 'UserInfo, with HTTP 403', 'The access token does not include `openid`.'],
        ],
      } },
      { heading: 'Introspection and revocation' },
      'Introspection returns `{ active: false }` for a token it does not know. For an active one it returns `active`, `scope`, `client_id`, `token_type`, `exp`, `iss`, `sub` and `username`. A client credentials token returns the client ID as `sub`. Revocation needs client authentication. Once the client is authenticated, it returns HTTP 200 whether or not the token was valid, and it revokes the token only when the token belongs to that application.',
    ],
  },
  {
    slug: 'reference-oauth2',
    section: 'Single sign-on',
    title: 'Reference: OAuth 2.0',
    summary: 'OAuth 2.0 endpoints, grant types, and how they differ from OpenID Connect.',
    visible: view,
    body: [
      { heading: 'Endpoints' },
      { table: {
        head: ['Purpose', 'Path'],
        rows: [
          ['Discovery', '`/oauth2/.well-known/oauth-authorization-server`'],
          ['Authorization', '`/oauth2/authorize`'],
          ['Token', '`/oauth2/token`'],
          ['UserInfo', '`/oauth2/userinfo` (`GET` or `POST`)'],
          ['Introspection', '`/oauth2/introspect` (confidential clients only)'],
          ['Revocation', '`/oauth2/revoke`'],
        ],
      } },
      { heading: 'Grant types' },
      { table: {
        head: ['Grant', 'For', 'Parameters'],
        rows: [
          ['`authorization_code`', 'A person signing in to the application.', 'As for [OpenID Connect](/help/reference-oidc), without `nonce` or `openid`.'],
          ['`refresh_token`', 'Renewing a person\'s tokens.', '`refresh_token`, optionally `scope`.'],
          ['`client_credentials`', 'A service acting in its own name. Confidential clients only.', '`scope`, which defaults to every allowed scope.'],
        ],
      } },
      { heading: 'Differences from OpenID Connect' },
      { table: {
        head: ['Feature', 'OpenID Connect', 'OAuth 2.0'],
        rows: [
          ['Scopes', 'Fixed: `openid`, `profile`, `email`, `groups`, `offline_access`.', 'Any names the administrator lists.'],
          ['`openid` scope', 'Required.', 'Not used.'],
          ['ID token', 'Returned when `openid` is granted.', 'Never returned.'],
          ['`iss` on the redirect', 'Sent.', 'Not sent.'],
          ['Signing keys (`/jwks`)', 'Published.', 'Not published.'],
          ['End session endpoint', 'Available.', 'Not available.'],
          ['Client credentials', 'Not offered.', 'Offered to confidential clients.'],
        ],
      } },
      { heading: 'Client credentials' },
      { code: `curl -s -u "$CLIENT_ID:$CLIENT_SECRET" \\
  -d grant_type=client_credentials \\
  -d scope="reports.read" \\
  https://idp.example.net/oauth2/token` },
      { bullets: [
        'The reply has an `access_token`, `token_type`, `expires_in` and `scope`. There is no refresh token and no user.',
        'UserInfo returns `invalid_token` for a client credentials token, because it has no user.',
        'Introspection returns the client ID as `sub` for it.',
        'Each request for a token issues a new one. A scope the application does not allow returns `invalid_scope`.',
      ] },
      { heading: 'Lifetimes and errors' },
      'Authorization codes last 60 seconds and are used once. Access tokens last the application\'s **Access token lifetime** (60 to 86400 seconds, default 3600). Refresh tokens last 30 days and rotate at each use. The errors match [Reference: OpenID Connect](/help/reference-oidc).',
    ],
  },
  {
    slug: 'reference-attribute-names',
    section: 'Single sign-on',
    title: 'Reference: attribute names',
    summary: 'Every attribute you can map, release, transform or use as a NameID or subject.',
    visible: view,
    body: [
      'These names appear in the **Attribute mapping** lists, the **Name ID Attribute**, the **Subject (sub) attribute**, the **User identifier** for CAS and attribute transformation rules. Multi-valued attributes cannot be used as a NameID or subject.',
      { table: {
        head: ['Key', 'Meaning', 'Multi-valued'],
        rows: [
          ['`guid`', 'GUID (objectGUID)', ''],
          ['`immutable_id`', 'Immutable ID: the GUID, base64-encoded', ''],
          ['`username`', 'Username', ''],
          ['`email`', 'Primary email address', ''],
          ['`first_name`, `last_name`, `display_name`', 'Names', ''],
          ['`employee_id`, `department`, `title`, `phone`', 'Employee ID and profile fields', ''],
          ['`upn`', 'User principal name (`userPrincipalName`)', ''],
          ['`sam_account_name`', '`sAMAccountName`', ''],
          ['`distinguished_name`', 'Distinguished name (`distinguishedName`)', ''],
          ['`mail_nickname`, `company`, `manager`, `office`, `mobile`', 'Directory fields (`mailNickname`, `company`, `manager`, `physicalDeliveryOfficeName`, `mobile`)', ''],
          ['`street_address`, `city`, `state`, `postal_code`, `country`, `description`', 'Address and description (`streetAddress`, `l`, `st`, `postalCode`, `c`, `description`)', ''],
          ['`groups`', 'Names of local groups the person belongs to', 'Yes'],
          ['`grouper_groups`', 'Names of Grouper groups', 'Yes'],
          ['`eduperson_principal_name`', 'eduPersonPrincipalName (`user@scope`)', ''],
          ['`eduperson_affiliation`', 'eduPersonAffiliation', 'Yes'],
          ['`eduperson_scoped_affiliation`', 'eduPersonScopedAffiliation', 'Yes'],
          ['`eduperson_targeted_id`', 'eduPersonTargetedID, per application', ''],
          ['`persistent_id`, `pairwise_id`, `subject_id`', 'Identifiers that differ for each application', ''],
          ['`schac_home_organization`', 'schacHomeOrganization', ''],
          ['`custom:<name>`', 'A user attribute you defined, such as `custom:badge`', 'No'],
        ],
      } },
      { tip: 'Attributes for federation (InCommon) are computed from the federation settings, so their values can differ for each application.' },
    ],
  },
];
