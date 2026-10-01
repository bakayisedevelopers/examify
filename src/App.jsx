import { AppRoutes } from './routes/AppRoutes';
import { RouteDocumentTitle } from './components/common/RouteDocumentTitle';

function App() {
  return <>
    <RouteDocumentTitle />
    <AppRoutes />
  </>;
}

export default App;
