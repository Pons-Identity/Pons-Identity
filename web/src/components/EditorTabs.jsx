import { Alert, Box, Button, Stack, Tab, Tabs } from '@mui/material';

// Whether any of a tab's fields differ from the version last saved. Compared by value, so a fresh copy of the same data is not a change.
export function changedFields(form, saved, fields = []) {
  return fields.some((f) => JSON.stringify(form[f]) !== JSON.stringify(saved[f]));
}

// The tabs of an editor. Only the tab showing can have changes, so while it has some, the other tabs cannot be opened.
export function EditorTabs({ tabs, value, dirty, onChange, ariaLabel }) {
  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Tabs value={value} variant="scrollable" aria-label={ariaLabel} onChange={(_, key) => { if (!dirty) onChange(key); }}>
        {tabs.map((t) => <Tab key={t.key} value={t.key} label={t.label} disabled={t.disabled} />)}
      </Tabs>
    </Box>
  );
}

// One tab's fields as a form, with the tab's own save and discard after them. Saving saves the whole item, which is the same as saving this tab, since no other tab can have changes.
export function TabForm({ dirty, canManage, saveLabel, onSubmit, onDiscard, children }) {
  return (
    <Stack component="form" onSubmit={onSubmit} spacing={2}>
      {dirty && <Alert severity="info">You have unsaved changes on this tab. Save or discard them before switching tabs.</Alert>}
      {children}
      {canManage && (
        <Stack direction="row" spacing={1}>
          <Button type="submit" variant="contained" disabled={!dirty}>{saveLabel}</Button>
          <Button disabled={!dirty} onClick={onDiscard}>Discard changes</Button>
        </Stack>
      )}
    </Stack>
  );
}
