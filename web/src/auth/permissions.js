import { useAuth } from './AuthContext.jsx';

// The permissions the server granted the signed-in user. The server enforces them; this only hides what would be refused.
export function useCan() {
  const { session } = useAuth();
  const held = new Set(session.me?.permissions || []);
  return (permission) => held.has(permission);
}
