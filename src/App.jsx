import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home/Home.jsx'
import Main_Layout from './layouts/Main_Layout/Main_Layout.jsx'
import "./App.css";
import DataIngestion from './pages/DataIngestion/DataIngestion.jsx'
import Datastitching from './pages/Datastitching/Datastitching.jsx'
import DataReview from './pages/DataReview/DataReview.jsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      {/* more routes as we build pages */}
       <Route element={<Main_Layout />}>
        <Route path="/data-ingestion" element={<DataIngestion />} />
        <Route path="/data-stitching" element={<Datastitching />} />
        <Route path="/data-review" element={<DataReview />} />

      </Route>
    </Routes>
  )
}

export default App