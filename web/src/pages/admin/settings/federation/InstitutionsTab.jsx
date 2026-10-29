import { Stack } from '@mui/material';
import { useCan } from '../../../../auth/permissions.js';
import SpForm from './SpForm.jsx';
import IdentitiesCard from './IdentitiesCard.jsx';

// Letting people from other institutions sign in here, and the people who already have.
export default function InstitutionsTab({ canManage, onChanged }) {
  const can = useCan();
  return (
    <Stack spacing={3}>
      <SpForm canManage={canManage} onChanged={onChanged} />
      <IdentitiesCard canManage={canManage} canLink={can('users.manage')} />
    </Stack>
  );
}
