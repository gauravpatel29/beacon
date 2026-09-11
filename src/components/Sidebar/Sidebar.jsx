import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Sidebar.css';
import home from "../../assets/sidebar_icon/home.png";
import cloud from "../../assets/sidebar_icon/cloud.png";
import chart from "../../assets/sidebar_icon/chart.png";
import dots from "../../assets/sidebar_icon/dots.png";
import graph from "../../assets/sidebar_icon/graph.png";
import data_lifecycle from "../../assets/sidebar_icon/data_lifecycle.png";
import bar_graph from "../../assets/sidebar_icon/bargraph.png";
import database from "../../assets/sidebar_icon/database.png";
import aim from "../../assets/sidebar_icon/aim.png";

const navItems = [
  { id: 'home',  icon: home, label: 'Home', path: '/' },
  { id: 'data-ingestion', icon: cloud, label: 'Data Ingestion', path: '/data-ingestion' },
  { id: 'data-stitching', icon: chart, label: 'Data Stitching & ARD', path: '/data-stitching' },
  { id: 'data-review', icon: dots, label: 'Data Review', path: '/data-review' },
  { id: 'data-transformation', icon: graph, label: 'Data Transformation', path: '/data-transformation' },
  { id: 'model-configuration ', icon:bar_graph, label: 'Model Configuration', path: '/model-configuration' },
  { id: 'model-output', icon:data_lifecycle, label: 'Model Output', path: '/model-output' },
  { id: 'optimization', icon: aim, label: 'Optimization', path: '/optimization' },
];

function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      {/* Collapse / expand toggle */}
      <button
        className="sidebar-toggle-btn"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '›' : '‹'}
      </button>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `sidebar-item${isActive ? ' active' : ''}`
            }
          >
            {item.icon && (
              <span className="placeholder icon-placeholder">
                <img src={item.icon} alt={item.label} />
              </span>
            )}
            <span className="sidebar-item-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

export default Sidebar;