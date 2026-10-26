import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import ProtectedRoute from './auth/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Login from './pages/Login.jsx';
import DocumentQueue from './pages/documents/DocumentQueue.jsx';
import DocumentReview from './pages/documents/DocumentReview.jsx';
import FollowUp from './pages/followUp/FollowUp.jsx';
import Payments from './pages/payments/Payments.jsx';
import PaymentDetail from './pages/payments/PaymentDetail.jsx';
import DeliveryDays from './pages/deliveries/DeliveryDays.jsx';
import DayDetail from './pages/deliveries/DayDetail.jsx';
import SpeedCharts from './pages/deliveries/SpeedCharts.jsx';

function RedirectOldDeliverDay() {
  const { dayId } = useParams();
  return <Navigate to={`/deliver/${dayId}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/deliver/login" element={<Navigate to="/login" replace />} />

      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="documents" element={<DocumentQueue />} />
        <Route path="documents/:id" element={<DocumentReview />} />
        <Route path="payments" element={<Payments />} />
        <Route path="payments/:id" element={<PaymentDetail />} />
        <Route path="follow-up" element={<FollowUp />} />
        <Route path="deliver" element={<DeliveryDays />} />
        <Route path="deliver/speed" element={<SpeedCharts />} />
        <Route path="deliver/:dayId" element={<DayDetail />} />
        <Route path="deliveries" element={<Navigate to="/deliver" replace />} />
        <Route path="deliveries/:dayId" element={<RedirectOldDeliverDay />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
