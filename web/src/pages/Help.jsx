import { Fragment } from 'react';
import { Alert, Box, Button, Card, CardActionArea, CardContent, Divider, InputAdornment, Link, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_PRODUCT_NAME, useAuth, useProductName } from '../auth/AuthContext.jsx';
import { useCan } from '../auth/permissions.js';
import { SECTIONS, visibleArticles } from '../help/articles.js';
import { searchArticles } from '../help/search.js';
import ErrorPage from '../components/ErrorPage.jsx';

// Help is written with the default product name; it is shown with the name the product goes by (Settings → Branding).
const named = (text, name) => text.replaceAll(DEFAULT_PRODUCT_NAME, name);

// Renders **bold**, `code` and [text](/help/slug) segments; everything else is plain text.
const INLINE = /(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/;
function Inline({ text }) {
  const name = useProductName();
  return named(text, name).split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <Box key={i} component="code" sx={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{part.slice(1, -1)}</Box>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    // Pages the server itself serves (the API documentation and its description) are plain links, not in-app routes.
    if (link && link[2].startsWith('/api/')) return <Link key={i} href={link[2]}>{link[1]}</Link>;
    if (link) return <Link key={i} component={RouterLink} to={link[2]}>{link[1]}</Link>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

const monoBlock = { m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre' };

function ArticleBlock({ block }) {
  const name = useProductName();
  if (typeof block === 'string') return <Typography><Inline text={block} /></Typography>;
  if (block.steps) {
    return (
      <Box component="ol" sx={{ m: 0, pl: 3, display: 'grid', gap: 1 }}>
        {block.steps.map((s) => <Typography component="li" key={s}><Inline text={s} /></Typography>)}
      </Box>
    );
  }
  if (block.bullets) {
    return (
      <Box component="ul" sx={{ m: 0, pl: 3, display: 'grid', gap: 0.5 }}>
        {block.bullets.map((s) => <Typography component="li" key={s}><Inline text={s} /></Typography>)}
      </Box>
    );
  }
  if (block.heading) return <Typography variant="subtitle1" component="h3" sx={{ mt: 1, fontWeight: 'bold' }}>{named(block.heading, name)}</Typography>;
  if (block.code) return <Box component="pre" sx={monoBlock}>{named(block.code, name)}</Box>;
  if (block.table) {
    return (
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 360 }}>
          <TableHead>
            <TableRow>{block.table.head.map((h) => <TableCell key={h} sx={{ fontWeight: 600, verticalAlign: 'bottom' }}><Inline text={h} /></TableCell>)}</TableRow>
          </TableHead>
          <TableBody>
            {block.table.rows.map((row, r) => (
              <TableRow key={r}>
                {row.map((cell, c) => <TableCell key={c} sx={{ verticalAlign: 'top' }}><Inline text={cell} /></TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    );
  }
  if (block.warning) return <Alert severity="warning"><Inline text={block.warning} /></Alert>;
  if (!block.tip) return null;
  return <Alert severity="info" icon={false}><Inline text={block.tip} /></Alert>;
}

function ArticleCard({ article }) {
  const name = useProductName();
  return (
    <Card variant="outlined">
      <CardActionArea component={RouterLink} to={`/help/${article.slug}`}>
        <CardContent>
          <Typography variant="subtitle1" component="h3">{named(article.title, name)}</Typography>
          <Typography variant="body2" color="text.secondary">{named(article.summary, name)}</Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

// Help index: a search over the articles, then one card per article the signed-in person may read, grouped by section.
function HelpIndex({ articles, query, onQuery }) {
  const text = query.trim();
  const matches = searchArticles(articles, text).results;
  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Typography variant="h5" component="h1">Help</Typography>
        <Typography color="text.secondary">Step-by-step guides for what you can do here, and reference for the details.</Typography>
      </Stack>
      <TextField
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search help"
        slotProps={{ htmlInput: { 'aria-label': 'Search help' }, input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> } }}
        sx={{ maxWidth: 480 }}
      />
      {text && (
        matches.length ? (
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' } }}>
            {matches.map((a) => <ArticleCard key={a.slug} article={a} />)}
          </Box>
        ) : <Typography color="text.secondary">No help matches “{text}”.</Typography>
      )}
      {!text && SECTIONS.map((section) => {
        const items = articles.filter((a) => a.section === section);
        if (!items.length) return null;
        return (
          <Stack key={section} spacing={1.5}>
            <Typography variant="h6" component="h2">{section}</Typography>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' } }}>
              {items.map((a) => <ArticleCard key={a.slug} article={a} />)}
            </Box>
          </Stack>
        );
      })}
      {!text && !articles.length && <Typography color="text.secondary">There is no help for your account yet.</Typography>}
    </Stack>
  );
}

function HelpArticle({ article, articles }) {
  const name = useProductName();
  const related = articles.filter((a) => a.section === article.section && a.slug !== article.slug);
  return (
    <Stack spacing={3} sx={{ maxWidth: 900 }}>
      <Link component={RouterLink} to="/help" underline="hover" variant="body2">← All help</Link>
      <Stack spacing={1}>
        <Typography variant="h5" component="h1">{named(article.title, name)}</Typography>
        <Typography color="text.secondary">{named(article.summary, name)}</Typography>
      </Stack>
      <Stack spacing={2}>
        {article.body.map((block, i) => <ArticleBlock key={i} block={block} />)}
      </Stack>
      {related.length > 0 && (
        <>
          <Divider />
          <Stack spacing={1} alignItems="flex-start">
            <Typography variant="subtitle2" component="h2">Related in {article.section}</Typography>
            {related.map((a) => <Button key={a.slug} component={RouterLink} to={`/help/${a.slug}`}>{named(a.title, name)}</Button>)}
          </Stack>
        </>
      )}
    </Stack>
  );
}

// Help hub at /help, and one article at /help/:slug. Articles the person may not read are treated as missing.
// The hub's search is kept in ?q=, so the global search's "See all" can open it with the same text.
export default function Help() {
  const { slug } = useParams();
  const [params, setParams] = useSearchParams();
  const { session } = useAuth();
  const can = useCan();
  const articles = visibleArticles({ can, me: session.me });

  if (!slug) {
    const onQuery = (q) => setParams(q ? { q } : {}, { replace: true });
    return <HelpIndex articles={articles} query={params.get('q') || ''} onQuery={onQuery} />;
  }
  const article = articles.find((a) => a.slug === slug);
  if (!article) return <ErrorPage title="Not found" message="That help article does not exist, or you do not have access to it." />;
  return <HelpArticle article={article} articles={articles} />;
}
