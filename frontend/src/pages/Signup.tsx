import { SignUp } from "@clerk/clerk-react";
import { AuthLayout } from "@/components/layout/AuthLayout";
import { ROUTES } from "@/constants/routes";

export default function Signup() {
  return (
    <AuthLayout tagline="Create your engineering workspace account">
      <SignUp
        path={ROUTES.signup}
        routing="path"
        signInUrl={ROUTES.login}
        forceRedirectUrl={ROUTES.dashboard}
      />
    </AuthLayout>
  );
}
