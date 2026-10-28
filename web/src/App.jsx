import { createContext, useContext, useState, useCallback } from 'react';
import { useApi, useRoute } from './lib.js';
import Overview from './pages/Overview.jsx';
import Cases from './pages/Cases.jsx';
import Actions from './pages/Actions.jsx';
import Health from './pages/Health.jsx';
import Models from './pages/Models.jsx';
import Audit from './pages/Audit.jsx';
import Settings from './pages/Settings.jsx';
import Import from './pages/Import.jsx';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0F2A4A" />
      <path d="M11 24V8h6.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="21.5" cy="23" r="2.3" fill="#3FB68B" />
    </svg>
  );
}

const Icon = ({ d }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const I = {
  overview: <Icon d={<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>} />,
  cases: <Icon d={<path d="M4 6h16M4 12h16M4 18h10" />} />,
  actions: <Icon d={<><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></>} />,
  health: <Icon d={<path d="M3 12h4l3 8 4-16 3 8h4" />} />,
  import: <Icon d={<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></>} />,
  models: <Icon d={<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7.5l3 8M16 7.5l-3 8" /></>} />,
  settings: <Icon d={<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>} />,
  audit: <Icon d={<><path d="M8 3h8l4 4v14H4V3h4" /><path d="M8 11h8M8 15h8M8 7h4" /></>} />,
};

const NAV = [
  ['/', 'Overview', I.overview, Overview],
  ['/cases', 'Cases', I.cases, Cases],
  ['/actions', 'Action queue', I.actions, Actions],
  ['/health', 'Payment health', I.health, Health],
  ['/import', 'Import data', I.import, Import],
  ['/models', 'Models', I.models, Models],
  ['/settings', 'Settings', I.settings, Settings],
  ['/audit', 'Audit log', I.audit, Audit],
];

export default function App() {
  const route = useRoute();
  const meta = useApi('/meta');
  const conn = useApi('/connection', { refreshMs: 30000 });
  const queue = useApi('/actions?status=proposed,task_open', { refreshMs: 30000 });
  const settings = useApi('/settings');
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState(null);
  const notify = useCallback((msg, err = false) => {
    setToast({ msg, err });
    clearTimeout(window.__toast);
    window.__toast = setTimeout(() => setToast(null), 4000);
  }, []);
  const refresh = useCallback(() => { conn.reload(); queue.reload(); settings.reload(); }, [conn, queue, settings]);

  const ctx = { meta: meta.data, conn: conn.data, settings: settings.data, notify, route, refresh };
  const pending = queue.data?.length ?? 0;

  let page;
  if (!meta.data) page = <div className="page empty">Loading…</div>;
  else {
    const P = NAV.find(([p]) => p === route.path)?.[3];
    page = P ? <P /> : <div className="page empty">Page not found. <a href="#/">Go to overview</a></div>;
  }

  const item = ([href, label, icon]) => (
    <a key={href} href={`#${href}`} className={`nav-item ${route.path === href ? 'active' : ''}`}>
      {icon}{label}
      {href === '/actions' && pending > 0 && <span className="count">{pending}</span>}
    </a>
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className="shell">
        <aside className={`sidebar ${menu ? 'open' : ''}`} onClick={() => setMenu(false)}>
          <a href="#/" className="logo"><Logo />Paylazar</a>
          {NAV.map(item)}
          <div className="sidebar-foot">
            <b>{settings.data?.businessName || 'Your business'}</b>
            <div>{conn.data?.data?.lastImport ? `Data imported ${new Date(conn.data.data.lastImport.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'No data imported yet'}</div>
          </div>
        </aside>
        <div className="main">
          <div className="mobile-bar">
            <a href="#/" className="logo" style={{ padding: 0 }}><Logo size={24} />Paylazar</a>
            <button className="btn sm" onClick={() => setMenu(true)}>Menu</button>
          </div>
          {page}
        </div>
      </div>
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </Ctx.Provider>
  );
}
