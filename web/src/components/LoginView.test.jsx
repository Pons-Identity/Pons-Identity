import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LoginView from './LoginView.jsx';
import { NotifyProvider } from './Notify.jsx';

test('the sign-in view draws the built-in background behind the card, with its filters, from the uploaded picture', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf', loginBackground: 'hills.png', loginBackgroundBlur: 4, loginBackgroundBrightness: 70, loginBackgroundContrast: 110 };
  const { container } = render(<NotifyProvider><MemoryRouter><LoginView branding={branding} assets={{ 'hills.png': '/api/branding/assets/9' }} preview /></MemoryRouter></NotifyProvider>);
  const bg = container.querySelector('.idp-bg');
  expect(bg).toBeInTheDocument();
  expect(bg.style.backgroundImage).toContain('/api/branding/assets/9');
  expect(bg.style.filter).toBe('blur(4px) brightness(70%) contrast(110%)');
  expect(container.querySelector('.idp-card')).toBeInTheDocument();
});

test('a solid background color replaces the theme color behind the built-in page, with text that reads on it', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf', loginBackgroundColor: '#101010' };
  const { container } = render(<MemoryRouter><LoginView branding={branding} preview /></MemoryRouter>);
  const page = container.querySelector('.idp-login');
  expect(container.querySelector('.idp-bg')).not.toBeInTheDocument();
  expect(getComputedStyle(page).backgroundColor).toBe('rgb(16, 16, 16)');
  expect(getComputedStyle(page).color).toBe('rgb(255, 255, 255)');
});

test('the built-in card look applies by default, and the administrator\'s CSS comes after it so it can override it', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf' };
  const { container } = render(<MemoryRouter><LoginView branding={branding} css={'.idp-card { border-radius: 4px; }'} /></MemoryRouter>);
  const css = container.querySelector('style').textContent;
  expect(css).toContain('.idp-login .idp-card');
  expect(css).toContain('backdrop-filter: blur(2px)');
  expect(css.indexOf('.idp-login .idp-card {')).toBeLessThan(css.indexOf('border-radius: 4px'));
});

test('a custom layout refers to uploaded pictures by name, which the page resolves to their addresses', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf' };
  const { container } = render(<MemoryRouter><LoginView branding={branding} template={'<img src="logo.png"><div class="x">{{username_input}}{{password_input}}{{submit_button}}</div>'}
    css={"& { background-image: url('bg.png'); }"} assets={{ 'logo.png': '/api/branding/assets/1', 'bg.png': '/api/branding/assets/2' }} preview /></MemoryRouter>);
  expect(container.querySelector('img').getAttribute('src')).toBe('/api/branding/assets/1');
  expect(container.querySelector('style').textContent).toContain("url('/api/branding/assets/2')");
  expect(container.querySelector('.idp-bg')).toBeNull();
});

test('the page is drawn in the mode it is given, with a class that says which, on its content', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf' };
  const { container, unmount } = render(<MemoryRouter><LoginView branding={branding} mode="dark" preview /></MemoryRouter>);
  expect(container.querySelector('.idp-dark .idp-card')).toBeInTheDocument();
  expect(container.querySelector('.idp-light')).toBeNull();
  unmount();
  const light = render(<MemoryRouter><LoginView branding={branding} mode="light" preview /></MemoryRouter>);
  expect(light.container.querySelector('.idp-light .idp-card')).toBeInTheDocument();
  expect(light.container.querySelector('.idp-dark')).toBeNull();
});

test('without a background picture, the page is drawn in a static color derived from the primary color', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf' };
  const { container, unmount } = render(<MemoryRouter><LoginView branding={branding} mode="light" preview /></MemoryRouter>);
  const light = getComputedStyle(container.querySelector('.idp-login')).backgroundColor;
  expect(light).toBeTruthy();
  expect(container.querySelector('.idp-bg')).toBeNull();
  unmount();
  const dark = render(<MemoryRouter><LoginView branding={branding} mode="dark" preview /></MemoryRouter>);
  expect(getComputedStyle(dark.container.querySelector('.idp-login')).backgroundColor).not.toBe(light);
});

test('the sign-in text sits in a footer bar, or under the card, as the administrator chose', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf', loginNotice: 'See [the guide](https://example.org).', loginNoticePlacement: 'footer' };
  const footer = render(<MemoryRouter><LoginView branding={branding} preview /></MemoryRouter>);
  expect(footer.container.querySelector('footer.idp-footer a[href="https://example.org"]')).toBeInTheDocument();
  expect(footer.container.querySelector('.idp-card')).toBeInTheDocument();
  footer.unmount();
  const below = render(<MemoryRouter><LoginView branding={{ ...branding, loginNoticePlacement: 'below-card' }} preview /></MemoryRouter>);
  expect(below.container.querySelector('footer')).toBeNull();
  expect(below.container.querySelector('.idp-notice a[href="https://example.org"]')).toBeInTheDocument();
});

test('the text below the card follows the administrator\'s panel, color and alignment choices', () => {
  const branding = { appName: 'Acme', primaryColor: '#1f5fbf', loginNotice: 'Hello', loginNoticePlacement: 'below-card',
    loginNoticePanel: false, loginNoticeColor: 'black', loginNoticeAlign: 'right' };
  const { container, unmount } = render(<MemoryRouter><LoginView branding={branding} preview /></MemoryRouter>);
  const text = container.querySelector('.idp-notice > div');
  expect(getComputedStyle(container.querySelector('.idp-notice')).textAlign).toBe('right');
  expect(getComputedStyle(text).color).toBe('rgb(0, 0, 0)');
  expect(getComputedStyle(text).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  unmount();
  const panel = render(<MemoryRouter><LoginView branding={{ ...branding, loginNoticePanel: true, loginNoticeColor: 'white', loginNoticeAlign: 'left' }} preview /></MemoryRouter>);
  expect(getComputedStyle(panel.container.querySelector('.idp-notice')).textAlign).toBe('left');
  expect(getComputedStyle(panel.container.querySelector('.idp-notice > div')).backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
});
