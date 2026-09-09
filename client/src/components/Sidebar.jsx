import React from "react";
import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { path: "/", label: "Home", icon: "🏠" },
  { path: "/ingestion", label: "Data Ingestion", icon: "📂" },
  { path: "/eda", label: "Exploratory Data Analysis", icon: "🔍" },
  { path: "/transformation", label: "Data Transformation", icon: "⚙️" },
  { path: "/modelling", label: "Modelling", icon: "🤖" },
  { path: "/results", label: "Model Results", icon: "📋" },
  { path: "/response-curves", label: "Response Curves", icon: "📈" },
  { path: "/optimization", label: "Optimization", icon: "🎯" },
];

export default function Sidebar() {
  return (
    <aside className="fixed top-0 left-0 h-full w-64 bg-[#001E96] text-white flex flex-col z-40 shadow-2xl">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-black tracking-tight text-white">
            Proc<span className="text-[#1ABC9C]">Timize</span>
          </span>
        </div>
        <p className="text-white/50 text-xs mt-1">Marketing Mix Modeling</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-6 py-3 text-sm font-medium transition-all duration-150 ${
                isActive
                  ? "bg-white/15 text-white border-r-4 border-[#1ABC9C]"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`
            }
          >
            <span className="text-base">{item.icon}</span>
            <span className="leading-tight">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-white/10">
        <p className="text-white/30 text-xs">© 2026 ProcDNA</p>
      </div>
    </aside>
  );
}