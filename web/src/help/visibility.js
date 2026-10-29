// Visibility tests for help articles. Each takes { can, me } and returns true when the article may be shown.

export const everyone = () => true;
export const admin = ({ me }) => me.is_admin;
// True when the person holds any of the given permissions, the same any-of rule as the admin module menu.
export const holds = (...permissions) => ({ can }) => permissions.some(can);
