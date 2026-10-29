import { useEffect, useState } from 'react';
import { Alert, Box, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import CopyButton from '../../../components/CopyButton.jsx';
import DownloadTextButton from '../../../components/DownloadTextButton.jsx';

const mono = { fontFamily: 'monospace', fontSize: 13 };
const pre = { m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...mono };

const Section = ({ title, id, children }) => (
  <Box component="section" aria-labelledby={id}>
    <Typography variant="h6" component="h2" id={id} gutterBottom>{title}</Typography>
    {children}
  </Box>
);

function TypeTable({ type }) {
  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" component="h3" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{type.name}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{type.description}</Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 1 }}>
        <Table size="small" aria-label={`${type.name} fields`}>
          <TableHead><TableRow><TableCell>Field</TableCell><TableCell>Type</TableCell><TableCell>Notes</TableCell></TableRow></TableHead>
          <TableBody>
            {type.fields.map((f) => (
              <TableRow key={f.name}>
                <TableCell sx={mono}>{f.name}{f.required && <Typography component="span" color="error" title="required"> *</Typography>}</TableCell>
                <TableCell sx={mono}>{f.type}</TableCell>
                <TableCell>{f.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box component="pre" sx={pre} aria-label={`${type.name} example`}>{JSON.stringify(type.example, null, 2)}</Box>
    </Box>
  );
}

// Everything a script author needs: the shape of every object, what starts a run, and every function with what it
// returns, how it fails and an example. It comes from the server, so it is what this server really has.
export function ReferenceBody({ reference, scopes }) {
  const { variables, inputs, functions, types, events, triggers, limits, attributes, recipes } = reference;
  return (
    <Stack spacing={4}>
      <Typography variant="body2" color="text.secondary">
              <i>Hint: Use the <b>Copy As Text</b> button to copy these instructions for use with your preferred AI LLM.</i>
            </Typography>
      <Typography variant="body2" color="text.secondary">
        A script is JavaScript that runs as the body of an <code>async</code> function, so <code>await</code> works anywhere and <code>return</code> stores a result.
        It has no <code>require</code>, <code>fetch</code>, file or process access: only what is listed here. Functions marked with a scope work only when the
        integration has been given it. Field types such as <code>User</code> are described under Objects.
      </Typography>

      <Section title="Starting a run" id="ref-triggers">
        {triggers.map((t) => <Typography key={t.name} variant="body2" sx={{ mb: 0.5 }}><strong>{t.name}.</strong> {t.description}</Typography>)}
      </Section>

      <Section title="Variables" id="ref-variables">
        {variables.map((v) => (
          <Box key={v.name} sx={{ mb: 1.5 }}>
            <Typography variant="body2"><code>{v.name}</code> — {v.description}</Typography>
            {v.example && <Box component="pre" sx={{ ...pre, mt: 0.5 }} aria-label={`${v.name} example`}>{v.example}</Box>}
          </Box>
        ))}
      </Section>

      <Section title="Attributes" id="ref-attributes">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          The user attributes defined in Settings → User attributes, with the type each value must have and an example of what it looks like.
          A script reads them from a user's <code>attributes</code> object, and writes them with <code>idp.users.update</code>.
        </Typography>
        {attributes.defined.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>None are defined yet. Any name can still be stored as free text.</Typography>
        )}
        {attributes.defined.length > 0 && (
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 1 }}>
            <Table size="small" aria-label="Defined attributes">
              <TableHead><TableRow><TableCell>Attribute</TableCell><TableCell>Type</TableCell><TableCell>Example value</TableCell><TableCell>Notes</TableCell></TableRow></TableHead>
              <TableBody>
                {attributes.defined.map((a) => (
                  <TableRow key={a.name}>
                    <TableCell sx={mono}>{a.name}</TableCell>
                    <TableCell sx={mono}>{a.type === 'enum' ? `one of ${a.options.join(' | ')}` : a.type}</TableCell>
                    <TableCell sx={mono}>{JSON.stringify(a.example)}</TableCell>
                    <TableCell>{a.label !== a.name ? `${a.label}.` : ''}{a.required ? ' Required.' : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        <Box component="pre" sx={pre} aria-label="Read an attribute example">{attributes.read}</Box>
        <Box component="pre" sx={{ ...pre, mt: 1 }} aria-label="Write an attribute example">{attributes.write}</Box>
      </Section>

      <Section title="Inputs" id="ref-inputs">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          The names an integration or function can take. Choose them in its Inputs table: the name is the key the caller passes, and the variable is what the code reads it into. Other names work too.
        </Typography>
        {inputs.map((i) => <Typography key={i.name} variant="body2" sx={{ mb: 0.5 }}><code>{i.name}</code> — {i.description}</Typography>)}
      </Section>

      <Section title="Objects" id="ref-objects">
        {types.map((t) => <TypeTable key={t.name} type={t} />)}
      </Section>

      <Section title="Events" id="ref-events">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          An integration can listen for these. They come from the audit log, so a change counts whether it came from the console, the user API, an import or a script.
          Changes made by an integration are never delivered, which keeps two integrations from starting each other. <code>input</code> is an Event.
        </Typography>
        {events.map((e) => (
          <Box key={e.name} sx={{ mb: 2 }}>
            <Typography variant="subtitle2" component="h3"><code>{e.name}</code> — {e.label}</Typography>
            {e.extra.map((x) => <Typography key={x} variant="body2" color="text.secondary">{x}</Typography>)}
            <Box component="pre" sx={{ ...pre, mt: 0.5 }} aria-label={`${e.name} example`}>{JSON.stringify(e.example, null, 2)}</Box>
          </Box>
        ))}
      </Section>

      <Section title="Functions" id="ref-functions">
        {functions.map((g, i) => (
          <Box key={`${g.group}-${g.scope}-${i}`} sx={{ mb: 3 }}>
            <Typography variant="subtitle1" component="h3" gutterBottom>
              {g.group}{g.scope && <Typography component="span" variant="body2" color="text.secondary"> — scope <code>{g.scope}</code>: {scopes[g.scope]}</Typography>}
            </Typography>
            {g.items.map((it) => (
              <Box key={it.signature} sx={{ mb: 2 }}>
                <Typography component="code" sx={{ display: 'block', fontWeight: 600, wordBreak: 'break-word', ...mono }}>{it.signature}</Typography>
                <Typography variant="body2">{it.description}</Typography>
                {it.returns && <Typography variant="body2" color="text.secondary"><strong>Returns</strong> {it.returns}</Typography>}
                {it.throws && <Typography variant="body2" color="text.secondary"><strong>Throws</strong> {it.throws}</Typography>}
                {it.example && <Box component="pre" sx={{ ...pre, mt: 0.5 }}>{it.example}</Box>}
              </Box>
            ))}
          </Box>
        ))}
      </Section>

      <Section title="Recipes" id="ref-recipes">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Complete scripts for common tasks. Copy one into a new integration, then change the names, groups and variables to match your systems.
        </Typography>
        {recipes.map((r) => (
          <Box key={r.title} sx={{ mb: 3 }}>
            <Typography variant="subtitle1" component="h3" gutterBottom>{r.title}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{r.description}</Typography>
            <Box component="pre" sx={pre} aria-label={`${r.title} script`}>{r.code}</Box>
          </Box>
        ))}
      </Section>

      <Section title="Limits" id="ref-limits">
        {limits.map(([k, v]) => <Typography key={k} variant="body2" sx={{ mb: 0.5 }}><strong>{k}.</strong> {v}</Typography>)}
      </Section>
    </Stack>
  );
}

// The same content as ReferenceBody, as plain text with no markup, for pasting into an LLM that helps write a script.
export function referenceText(reference, scopes) {
  const { variables, inputs, functions, types, events, triggers, limits, attributes, recipes } = reference;
  const json = (value) => JSON.stringify(value, null, 2).split('\n').map((line) => `  ${line}`);
  const out = [
    'INTEGRATION SCRIPT REFERENCE',
    '',
    'A script is JavaScript that runs as the body of an async function, so await works anywhere and return stores a result.',
    'It has no require, fetch, file or process access: only what is listed here. Functions marked with a scope work only when the',
    'integration has been given it. Field types such as User are described under Objects.',
    '',
    'STARTING A RUN',
    ...triggers.map((t) => `${t.name}. ${t.description}`),
    '',
    'VARIABLES',
    ...variables.flatMap((v) => (v.example ? [`${v.name} — ${v.description}`, `  Example: ${v.example}`] : [`${v.name} — ${v.description}`])),
    '',
    'ATTRIBUTES',
    'The user attributes defined in Settings → User attributes, with the type each value must have and an example value.',
    ...(attributes.defined.length ? attributes.defined.map((a) => `${a.name} — ${a.type === 'enum' ? `one of ${a.options.join(' | ')}` : a.type}${a.required ? ' (required)' : ''}. Example: ${JSON.stringify(a.example)}`) : ['None are defined yet. Any name can still be stored as free text.']),
    'Read:', ...attributes.read.split('\n').map((line) => `  ${line}`),
    'Write:', ...attributes.write.split('\n').map((line) => `  ${line}`),
    '',
    'OBJECTS',
  ];
  types.forEach((t) => {
    out.push('', `${t.name} — ${t.description}`);
    t.fields.forEach((f) => out.push(`  ${f.name}${f.required ? ' (required)' : ''}: ${f.type}${f.description ? `. ${f.description}` : ''}`));
    out.push('  Example:', ...json(t.example));
  });
  out.push(
    '',
    'INPUTS',
    'The names an integration or function can take. Choose them in its Inputs table: the name is the key the caller passes, and the variable is what the code reads it into. Other names work too.',
    ...inputs.map((i) => `${i.name} — ${i.description}`),
    '',
    'EVENTS',
    'An integration can listen for these. They come from the audit log, so a change counts whether it came from the console, the user API, an import or a script.',
    'Changes made by an integration are never delivered, which keeps two integrations from starting each other. input is an Event.',
  );
  events.forEach((e) => {
    out.push('', `${e.name} — ${e.label}`, ...e.extra.map((x) => `  ${x}`), '  Example:', ...json(e.example));
  });
  out.push('', 'FUNCTIONS');
  functions.forEach((g) => {
    out.push('', `${g.group}${g.scope ? ` — scope ${g.scope}: ${scopes[g.scope]}` : ''}`);
    g.items.forEach((it) => {
      out.push('', it.signature, `  ${it.description}`);
      if (it.returns) out.push(`  Returns: ${it.returns}`);
      if (it.throws) out.push(`  Throws: ${it.throws}`);
      if (it.example) out.push('  Example:', ...it.example.split('\n').map((line) => `    ${line}`));
    });
  });
  out.push('', 'RECIPES', 'Complete scripts for common tasks.');
  recipes.forEach((r) => {
    out.push('', r.title, `  ${r.description}`, '  Script:', ...r.code.split('\n').map((line) => `    ${line}`));
  });
  out.push('', 'LIMITS', ...limits.map(([k, v]) => `${k}. ${v}`));
  return `${out.join('\n')}\n`;
}

export default function Reference() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/admin/integrations').then(setData).catch((e) => setError(e.message)); }, []);
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;
  return (
    <Stack spacing={2}>
      <Box>
        <CopyButton value={referenceText(data.reference, data.scopes)} label="Copy as text" />
        <DownloadTextButton value={referenceText(data.reference, data.scopes)} filename="integration-script-reference.txt" />
      </Box>
      <ReferenceBody reference={data.reference} scopes={data.scopes} />
    </Stack>
  );
}
