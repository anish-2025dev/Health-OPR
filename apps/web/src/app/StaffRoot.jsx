import { AuthProvider } from '@/features/auth/auth-context';
import { App } from './App';

export default function StaffRoot() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
