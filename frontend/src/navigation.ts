export const navigateApp = (path: string) => {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

(window as Window & {zetdcNavigate?: (path: string) => void}).zetdcNavigate = navigateApp;
