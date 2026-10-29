import { useState } from 'react';
import { SpeedDial, SpeedDialAction } from '@mui/material';
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';

// The color theme choices, with the icon each one shows.
export const COLOR_MODES = [
  { value: 'system', label: 'System', Icon: SettingsBrightnessIcon },
  { value: 'light', label: 'Light', Icon: LightModeIcon },
  { value: 'dark', label: 'Dark', Icon: DarkModeIcon },
];

// A speed dial in the bottom right of every page. The main button shows the current choice; opening it shows the other two.
export default function ColorModeDial({ mode, onChange }) {
  const [open, setOpen] = useState(false);
  const current = COLOR_MODES.find((m) => m.value === mode) || COLOR_MODES[0];
  const choose = (value) => {
    setOpen(false);
    onChange(value);
  };
  return (
    <SpeedDial ariaLabel="Color theme" icon={<current.Icon />} open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
      direction="up" sx={{ position: 'fixed', bottom: 24, right: 24 }}>
      {COLOR_MODES.map(({ value, label, Icon }) => (
        <SpeedDialAction key={value} icon={<Icon />} tooltipTitle={value === mode ? `${label} (current)` : label}
          aria-pressed={value === mode} onClick={() => choose(value)} />
      ))}
    </SpeedDial>
  );
}
