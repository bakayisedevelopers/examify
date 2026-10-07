import { AppRoutes } from './routes/AppRoutes';
import { RouteDocumentTitle } from './components/common/RouteDocumentTitle';
import { CookieConsentManager } from './components/privacy/CookieConsentManager';
import { PortalAccessGuard } from './components/common/PortalAccessGuard';
import { OperationStatusProvider } from './components/common/OperationStatusProvider';

function App() {
  return (
    <OperationStatusProvider>
      <RouteDocumentTitle />
      <PortalAccessGuard>
        <AppRoutes />
      </PortalAccessGuard>
      <CookieConsentManager />
    </OperationStatusProvider>
  );
}

export default App;
