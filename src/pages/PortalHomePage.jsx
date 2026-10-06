import { LandingPage } from './LandingPage';
import { RoleLandingPage } from './RoleLandingPage';
import { getPortal } from '../utils/portal';

export const PortalHomePage = () => {
  const portal = getPortal();
  return portal === 'student' ? <LandingPage /> : <RoleLandingPage portal={portal} />;
};
