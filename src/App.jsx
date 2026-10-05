import { AppRoutes } from './routes/AppRoutes';
import { RouteDocumentTitle } from './components/common/RouteDocumentTitle';
import { CookieConsentManager } from './components/privacy/CookieConsentManager';

function App() {
  return <>
    <RouteDocumentTitle />
    <AppRoutes />
    <CookieConsentManager />
  </>;
}

export default App;
