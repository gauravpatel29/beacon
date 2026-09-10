import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import { AppProvider } from "./context/AppContext";
import Sidebar from "./components/Sidebar";

import Home from "./pages/Home";
import DataIngestion from "./pages/DataIngestion";
import EDA from "./pages/EDA";
import DataTransformation from "./pages/DataTransformation";
import Modelling from "./pages/Modelling";
import ModelResults from "./pages/ModelResults";
import ResponseCurves from "./pages/ResponseCurves";
import Optimization from "./pages/Optimization";
import DataStitching from "./pages/DataStitching";

function Layout({ children }) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />
      <main className="flex-1 ml-64 p-8 min-h-screen overflow-auto">
        {children}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Toaster position="top-right" toastOptions={{ duration: 4000 }} />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/ingestion" element={<Layout><DataIngestion /></Layout>} />
          <Route path="/ard-stitching" element={<Layout><DataStitching /></Layout>} />
          <Route path="/eda" element={<Layout><EDA /></Layout>} />
          <Route path="/transformation" element={<Layout><DataTransformation /></Layout>} />
          <Route path="/modelling" element={<Layout><Modelling /></Layout>} />
          <Route path="/results" element={<Layout><ModelResults /></Layout>} />
          <Route path="/response-curves" element={<Layout><ResponseCurves /></Layout>} />
          <Route path="/optimization" element={<Layout><Optimization /></Layout>} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}