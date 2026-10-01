import { useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ROLES } from '../lib/constants';

export const useEffectiveRole = () => {
  const location = useLocation();
  const { profile } = useAuth();
  const isTeacher = profile?.isTeacher || location.pathname.startsWith('/teacher');
  const role = isTeacher ? 'teacher' : (profile?.role || ROLES.TUTOR);
  return {
    isTeacher,
    role,
    roleName: isTeacher ? 'teacher' : 'tutor',
    RoleName: isTeacher ? 'Teacher' : 'Tutor',
    basePath: isTeacher ? '/teacher' : '/tutor',
  };
};
