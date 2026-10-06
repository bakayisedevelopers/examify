import { AppRoutes } from './routes/AppRoutes';
import { RouteDocumentTitle } from './components/common/RouteDocumentTitle';
import { CookieConsentManager } from './components/privacy/CookieConsentManager';
import { PortalAccessGuard } from './components/common/PortalAccessGuard';

function App() {
  return <>
    <RouteDocumentTitle />
    <PortalAccessGuard>
      <AppRoutes />
    </PortalAccessGuard>
    <CookieConsentManager />
  </>;
}

export default App;
