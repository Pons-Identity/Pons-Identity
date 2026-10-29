import { useEffect, useState } from 'react';
import { api } from '../../../../api/client.js';
import { useNotify } from '../../../../components/Notify.jsx';

// The federation identity's settings. The Federation settings, Signing and encryption and Attribute release tabs edit one draft,
// so a change made on one tab is still there on another until it is saved.
export default function useIdentityForm({ onChanged }) {
  const notify = useNotify();
  const [view, setView] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  const apply = (v) => { setView(v); setCfg(v.config); };
  useEffect(() => { api('/admin/federation/idp').then(apply).catch((e) => setErrors([e.message])); }, []);

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setIn = (group, key, value) => setCfg((c) => ({ ...c, [group]: { ...c[group], [key]: value } }));
  const setContact = (kind, key, value) => setCfg((c) => ({ ...c, contacts: { ...c.contacts, [kind]: { ...c.contacts[kind], [key]: value } } }));
  const setKeys = (keys) => { setView((v) => ({ ...v, keys })); onChanged(); };

  async function save(e) {
    e.preventDefault();
    setErrors([]);
    setSaving(true);
    try {
      apply(await api('/admin/federation/idp', { method: 'PUT', body: cfg }));
      onChanged();
      notify('Federation settings saved');
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  return { view, cfg, errors, saving, set, setIn, setContact, setKeys, save };
}
