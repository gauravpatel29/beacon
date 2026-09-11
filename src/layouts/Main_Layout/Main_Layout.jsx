import {Outlet} from "react-router-dom";
import "./Main_Layout.css";
import Navbar from "../../components/Navbar/Navbar";
import Sidebar from "../../components/Sidebar/Sidebar";
function MainLayout() {
  return (
    <div className="main-layout">
      <Navbar />
 
      <div className="main-layout-body">
        <Sidebar />
        <main className="page-content">
          <Outlet />
        </main>
        
      </div>
    </div>
  );
}
 
export default MainLayout;

