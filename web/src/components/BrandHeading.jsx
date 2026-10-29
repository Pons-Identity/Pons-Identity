import { Box, Typography } from '@mui/material';

// The product's mark at the start of a header. A logo (square) goes to the left of the name, which is kept. A logotype (wordmark)
// takes the place of the name; the name stays as its alt text. `height` is the height of the images.
export default function BrandHeading({ appName, logo, wordmark, height = 32 }) {
  return (
    <>
      {logo && <Box component="img" src={logo} alt="" sx={{ height, width: 'auto', maxWidth: height * 2, objectFit: 'contain' }} />}
      {wordmark
        ? <Box component="img" src={wordmark} alt={appName} sx={{ height, width: 'auto', maxWidth: height * 6, objectFit: 'contain' }} />
        : <Typography variant="h6" color="inherit">{appName}</Typography>}
    </>
  );
}
